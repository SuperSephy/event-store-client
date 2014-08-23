var net = require('net');
var uuid = require('node-uuid');
var nconf = require('nconf');

var Messages = require("./lib/messages");
var Commands = require("./lib/commands");

/*************************************************************************************************/
// TCP Flags
var FLAGS_NONE             = 0x00;
var FLAGS_AUTH             = 0x01;

var UINT32_LENGTH          = 4;
var GUID_LENGTH            = 16;
var HEADER_LENGTH          = 1 + 1 + GUID_LENGTH; // Cmd + Flags + CorrelationId

var COMMAND_OFFSET         = UINT32_LENGTH;
var FLAGS_OFFSET           = COMMAND_OFFSET + 1;
var CORRELATION_ID_OFFSET  = FLAGS_OFFSET + 1;
var DATA_OFFSET            = CORRELATION_ID_OFFSET + GUID_LENGTH; // Length + Cmd + Flags + CorrelationId

/*************************************************************************************************/
// CONFIGURATION
// First consider commandline arguments and environment variables, respectively.
nconf.argv().env();

// Then load configuration from a designated file.
nconf.file({
	file: 'config.json'
});

// Provide default values for settings not provided above.
nconf.defaults({
    'eventStore': {
    	'address': "127.0.0.1",
        'port': 1113,
        'stream': '$stats-127.0.0.1:2113',
        'credentials': {
			'username': "admin",
			'password': "changeit"
        }
    },
    'debug': true
});


var debug = nconf.get('debug');

/*************************************************************************************************/

var callbacks = {
};

var currentOffset = 0;
var currentMessage = null;

var options = {
	host: nconf.get('eventStore:address'),
	port: nconf.get('eventStore:port'),
};
console.log('Connecting to ' + options.host + ':' + options.port + '...');
var connection = net.connect(options, function() {
	connection.on('error', function(err) {
		console.error(err);
		connection.end();
	});

	connection.on('data', function(data) {
		while (data != null) {
			if (currentMessage == null) {
				// Read the command length
				var commandLength = data.readUInt32LE(0);
				if (commandLength < HEADER_LENGTH) {
					console.error('Invalid command length of ' + commandLength + ' bytes. Needs to be at least big enough for the header')
					connection.close();
				}

				// The entire message will include the command length at the start
				var messageLength = UINT32_LENGTH + commandLength;
				if (data.length == messageLength) {
					// A single packet message, no need to copy into another buffer
					receiveMessage(data);
					data = null;
				} else if (data.length > messageLength) {
					// Multiple messages in one packet
					var firstMessage = data.slice(0, messageLength);
					receiveMessage(firstMessage);
					data = data.slice(currentLength, data.length - currentLength);
				} else {
					// The first packet of a multi-packet message
					currentMessage = new Buffer(messageLength);
					var packetLength = data.copy(currentMessage, currentOffset, 0);
					currentOffset = packetLength;
					data = null;
				}
			} else {
				// Another packet for a multi-packet message
				var packetLength = data.copy(currentMessage, currentOffset, 0);
				currentOffset += packetLength;
				if (currentOffset >= currentMessage.length) {
					// Finished receiving the current message
					receiveMessage(currentMessage);
					currentMessage = null;
					currentOffset = 0;
				}
				data = null;
			}
		}
	});

	
	console.log('Connected');

	sendPing();

	var streamId = nconf.get('eventStore:stream');
	var credentials = nconf.get('eventStore:credentials');
	console.log('Subscribing to ' + streamId + "...")
	subscribeToStream(streamId, true, function(streamEvent) {
		var cpuPercent = Math.ceil(100 * streamEvent.data["proc-cpu"]);
		var receivedBytes = streamEvent.data["proc-tcp-receivedBytesTotal"];
		var sentBytes = streamEvent.data["proc-tcp-sentBytesTotal"];
		console.log("ES CPU " + cpuPercent + "%, TCP Bytes Received " + receivedBytes + ", TCP Bytes Sent " + sentBytes);
	}, credentials);

	function sendPing() {
		sendMessage(Commands.Ping, null, null, function(pkg) {
			console.log('Received ' + Commands.getCommandName(pkg.command) + ' response!');
		});
	}

	function subscribeToStream(streamName, resolveLinkTos, callback, credentials) {
		var subscribeRequest = new Messages.SubscribeToStream(streamName, resolveLinkTos);
		var data = subscribeRequest.encode().toBuffer();

		var correlationId = sendMessage(Commands.SubscribeToStream, credentials, data, function(pkg) {
			switch (pkg.command) {
				case Commands.SubscriptionConfirmation:
					var confirmation = Messages.SubscriptionConfirmation.decode(pkg.data);
					console.log("Subscription confirmed (last commit " + confirmation.last_commit_position + ", last event " + confirmation.last_event_number + ")");
					break;

				case Commands.SubscriptionDropped:
					var dropped = Messages.SubscriptionDropped.decode(pkg.data);
					var reason = dropped.reason;
					switch (dropped.reason) {
						case 0:
							reason = "unsubscribed";
							break;
						case 1:
							reason = "access denied";
							break;
					}
					console.log("Subscription dropped (" + reason + ")");
					break;

				case Commands.StreamEventAppeared:
					var eventAppeared = Messages.StreamEventAppeared.decode(pkg.data);

					// StreamEventAppeared.ResolvedEvent.EventRecord
					var eventRecord = eventAppeared.event.event;
					var event = {
						stream_id: eventRecord.event_stream_id,
						number: eventRecord.event_number,
						id: eventRecord.event_id.toString('hex'),
						type: eventRecord.event_type,
						created: eventRecord.created
					}

					var data = eventRecord.data.toBuffer();
					if (data[0] == 0x7B) {
						// JSON
						event.data = JSON.parse(data.toString());
					} else {
						// Binary
						event.data = data;
						event.data_hex = data.toString('hex');
					}

					callback(event);
					break;

				default:
					console.log('TODO: Add support for parsing ' + Commands.getCommandName(pkg.command) + ' events');
					break;
			}
		});
		return correlationId;
	}

	/*************************************************************************************************/

	function createGuid() {
		var buffer = new Buffer(GUID_LENGTH);
		uuid.v1({}, buffer)
		return buffer;
	}


	function sendMessage(command, credentials, data, callback) {
		var correlationId = createGuid();
		var key = correlationId.toString('hex');
		if (callback != null) {
			callbacks[key] = callback;
		}

		// Handle authentication
		var authLength = 0;
		var flags = FLAGS_NONE;
		if (credentials) {
			flags = FLAGS_AUTH;
			// FIXME: Add support for multi-byte characters
			authLength = 1 + credentials.username.length + 1 + credentials.password.length;
		}

		var commandLength = HEADER_LENGTH + authLength;
		if (data != null) {
			commandLength += data.length;
		}
		var packetLength = 4 + commandLength;
		var buf = new Buffer(packetLength);
		//console.log("Command " + command + ", Flags " + flags +", CorrelationId " + correlationId.toString('hex') + ", Packet length " + packetLength)

		// Command length (4 bytes)
		buf.writeUInt32LE(commandLength, 0);

		// TCP Command (1 byte) + TCP Flags (1 byte)
		buf[COMMAND_OFFSET] = command;
		buf[FLAGS_OFFSET] = flags;

		// Correlation ID (16 byte GUID)
		correlationId.copy(buf, CORRELATION_ID_OFFSET, 0, GUID_LENGTH);

		// User's credentials
		if (credentials) {
			buf.writeUInt8(credentials.username.length, DATA_OFFSET);
			buf.write(credentials.username, DATA_OFFSET + 1);
			buf.writeUInt8(credentials.password.length, DATA_OFFSET + 1 + credentials.username.length);
			buf.write(credentials.password, DATA_OFFSET + 1 + credentials.username.length + 1);
		}

		if (data != null) {
			data.copy(buf, DATA_OFFSET + authLength, 0, data.length);
		}

		if (debug) {
			console.log('Outbound: ' + buf.toString('hex') + ' (' + buf.length + ' bytes) ' + Commands.getCommandName(command));
		}
		connection.write(buf);
		return key;
	}

	function receiveMessage(buf) {
		var command = buf[COMMAND_OFFSET];
		if (debug) {
			console.log('Inbound:  ' + buf.toString('hex') + ' (' + buf.length + ' bytes) ' + Commands.getCommandName(command));
		}

		// Read the packet length
		var commandLength = buf.readUInt32LE(0);
		if (commandLength < HEADER_LENGTH) {
			console.error('Invalid command length of ' + commandLength + ' bytes. Needs to be at least big enough for the header')
			connection.close();
		}

		// Read the header
		//var command = buf[COMMAND_OFFSET];
		var flags = buf[FLAGS_OFFSET];
		var correlationId = buf.toString('hex', CORRELATION_ID_OFFSET, CORRELATION_ID_OFFSET + GUID_LENGTH);
		
		// Read the payload data
		var dataLength = commandLength - HEADER_LENGTH;
		var data = new Buffer(dataLength);
		if (dataLength > 0) {
			buf.copy(data, 0, DATA_OFFSET, DATA_OFFSET + dataLength);
		}

		// Handle the message
		if (command == Commands.HeartbeatRequest) {
			// Automatically respond to heartbeat requests
			sendMessage(Commands.HeartbeatResponse);

		} else if (callbacks.hasOwnProperty(correlationId)) {
			// Handle the callback that was previously registered when the request was sent
			var callback = callbacks[correlationId];
			//delete callbacks[correlationId]; // FIXME: Some requests are single hit (like ping), others are persistent (like subscribe)

			var pkg = {
				command: command,
				flags: flags,
				data: data
			}

			try {
				callback(pkg);
			} catch (x) {
				console.error("Callback for " + correlationId + " failed, unhooking.\r\n" + x);
				delete callbacks[correlationId];
			}
		} else {
			console.warn('Received ' + getCommandName(command) + ' message with unknown correlation ID: ' + correlationId);
		}
	}
});