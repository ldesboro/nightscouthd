//basic web server to display data from Dexcom G4
//requires a small program which sits on the 
//Dexcom Studio DLL and creates a CSV file
//this program reads the csv file, parses it, then
//acts as a web server to display the current value
//Taken from Lane D.
var bgData = [];
var test = false;
var port = process.env.PORT || 1337;
var refresh_rate = (test === true ? 0.1 : 1) * 60 * 1000;
var nodeStatic = require('node-static');
var fs = require('fs');
var staticServer = new nodeStatic.Server(".");
var TZ_offset_hrs = new Date().getTimezoneOffset()/60;  

console.log("server datetime: ", new Date().toISOString());
console.log('listening on port ', port);

//Setup node http server
var server = require('http').createServer(function serverCreator(request, response) {
    var sys = require("sys");
    // Grab the URL requested by the client and parse any query options
    var url = require('url').parse(request.url, true);

    // Serve file using node-static
    staticServer.serve(request, response, function clientHandler(err) {
        if (err) {
            // Log the error
            sys.error("Error serving " + request.url + " - " + err.message);

            // Respond to the client
            response.writeHead(err.status, err.headers);
            response.end('Error 404 - file not found');
        }
    });
}).listen(port);

//Setup socket io for data and message transmission
var io = require('socket.io').listen(server);

//Default to 36 data points
var historyLength = 12 * 3;

var clients = [];

//Initialize last ACK to 1 hour ago
var lastAckTime = Date.now() - 3600000;

//Grab csv from ftp site and store locally
var Client = require('ftp');
var c = new Client();
c.on('ready', function() {
  c.get('dexcom/hayden.csv', function(err, stream) {
    if (err) throw err;
    stream.setEncoding('utf8');
    stream.once('close', function() { c.end(); });
    stream.pipe(fs.createWriteStream('hayden.csv'));
  });
});

// connect to FTP server to grab CSV and save it to Azure
setInterval(function() {
    c.connect({host: "ftp.ilovemypancreas.org"});
}, Math.round(refresh_rate*0.9));

//Reloads the csv file
function update() {
	fs.readFile('Hayden.csv', 'utf-8', function fileReader(error, data) {
	    if (error) {
	        console.log("Error reading csv file.");
	    } else {
	        // parse the csv file into lines
	        var lines = data.trim().split('\n');
	        var latest = lines.length - 1;
	        var actual = [];

	        //Only get the most recent sgv data points
	        for (var i = latest; i > latest - historyLength; i--) {
	            lines[i] = lines[i].split(",");
	            actual.unshift({ x: new Date(lines[i][1]).getTime()+(7-TZ_offset_hrs)*3600*1000, y: lines[i][0] });
	        }
	        console.log("data timezone: ", new Date(lines[latest][1]).getTimezoneOffset() / 60, "  server timezone: ", TZ_offset_hrs);

	        //Predict using AR model
	        var predicted = [];
	        var actual_len = actual.length - 1;
	        var lastValidReadingTime = actual[actual_len].x;
	        var elapsed_min = (actual[actual_len].x - actual[actual_len - 1].x) / (60*1000);
	        var BG_REF = 140;
	        var y = Math.log(actual[actual_len].y / BG_REF);

	        if (elapsed_min < 5.1) {
	            y = [Math.log(actual[actual_len - 1].y / BG_REF), y];
	        } else {
	            y = [y, y];
	        }

	        var n = Math.ceil(12 * (1 / 2 + (Date.now() - lastValidReadingTime) / 3600 / 1000));   //Predict 1/2 hour ahead
	        var AR = [-0.723, 1.716];                   //AR calculation constants
	        var dt = actual[actual_len].x;
	        for (i = 0; i <= n; i++) {
	            y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
	            dt = dt + 5 * 60 * 1000;
	            predicted[i] = {
	                x: dt,
	                y: Math.round(BG_REF * Math.exp(y[1]))
	            };
	        }

	        //Remove measured points that don't lie within the time range
	        while (actual.length > 0 && actual[0].x < Date.now() - historyLength * 5 * 60 * 1000) { actual.shift(); }

	        bgData = [actual, predicted];
	        io.sockets.emit("sgv", bgData);

	        var now = Date.now();
	        var avgLoss = 0;
	        if (now > lastAckTime + 40 / 60 * 3600 * 1000) {
	            for (i = 0; i <= 6; i++) {
	                avgLoss += 1 / 6 * Math.pow(log10(predicted[i].y / 120), 2);
	            }
	            console.log("The average loss is: " + Math.round(avgLoss * 100) / 100);
	            if (avgLoss > 0.2) {
	                io.sockets.emit('urgent_alarm');
	            } else if (avgLoss > 0.05) {
	                io.sockets.emit('alarm');
	            }
	        }
	    }
	});
}

var sensorReadID = setInterval(update, refresh_rate);

io.set('log level', 1); // reduce logging
//Windows Azure Web Sites does not currently support WebSockets, so for long-polling
io.configure(function () {                
  io.set('transports', ['xhr-polling']);  
});                                       

io.sockets.on('connection', function (socket) {
    socket.emit("TZ", TZ_offset_hrs);
    socket.emit("sgv", bgData);
    socket.on('update', function (data) {
        console.log("updating time scale to " + data + " hours");
        historyLength = data * 12;
        update();
    });
    socket.on('ack', function(time) { lastAckTime = time; })
});

function log10(val) { return Math.log(val) / Math.LN10; }
