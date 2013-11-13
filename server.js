//NightScout server

//This file is part of NightScout.

//NightScout is free software: you can redistribute it and/or modify
//it under the terms of the GNU General Public License as published by
//the Free Software Foundation, either version 3 of the License, or
//(at your option) any later version.

//NightScout is distributed in the hope that it will be useful,
//but WITHOUT ANY WARRANTY; without even the implied warranty of
//MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//GNU General Public License for more details.

//You should have received a copy of the GNU General Public License
//along with NightScout.  If not, see <http://www.gnu.org/licenses/>.

//basic web server to display data from Dexcom G4
//requires a small program which sits on the 
//Dexcom Studio DLL and creates a CSV file
//this program reads the csv file, parses it, then
//acts as a web server to display the current value

//Lane D and Ross N

var bgData = [];
var cgmfile ;
var treatmentfile ;
var port = process.env.PORT || 1337;
var ftp_refresh_rate = 121121; // ~121 seconds - a weird number so it doesn't coincide with refresh_rate and collide with file reads

var simulated = false;
var sim_start = new Date("2013-10-15T18:56:00.123Z").getTime();

var now = (simulated === true ? sim_start : new Date().getTime());

var nodeStatic = require('node-static');
var fs = require('fs');
var staticServer = new nodeStatic.Server(".");
var TZ_offset_hrs = new Date().getTimezoneOffset()/60;  
var ftp = require("./ftp_credentials.json")
var initialize = true;  // only load the simulated data once
var mbg = [];
var treatmentdata = [];
var cgmdata = [];
var Client = require('ftp');
var c = new Client();

//Default to 2 days
var historyLength = 60 * 24 * 2 / 5; //2 days

var clients = [];

//Initialize last ACK
var lastAckTime = 0;

console.log("server datetime: ", new Date());


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

function refresh_rate(){
    var rr = (simulated? 3 : (initialize ? 15 : 60)) * 1000
    return [rr];
}

function update() {
    //console.log('updated:',new Date, '   displayed time:',new Date(now),' refresh rate:', new refresh_rate/1000)
	
	cgmfile = (simulated === true ? "hayden_oct.csv" : "hayden.csv");
	treatmentfile = (simulated === true ? "treatment_oct.csv" : "treatment.csv");

    if (initialize === true) {
        now = (simulated === true ? sim_start : new Date().getTime());
    }
    else {
        now = (simulated === true ? now + 5 * 60 * 1000 : Date.now());
    }

    if (!simulated) {
        //	Grab csv from ftp site and store locally

		c.on('ready', function() {
			c.get(ftp.file, function(err, stream) {
				if (err) throw err;
				stream.setEncoding('utf8');
				stream.once('close', function() { c.end(); });
				stream.pipe(fs.createWriteStream('hayden.csv',{'flags':'w'}));  //append using 'a' flag
			});
		});
		//	connect to FTP server to grab CSV and save it to Azure
		setInterval(function() {
			c.connect({host: ftp.host, user: ftp.user, password: ftp.password});
		}, Math.round(ftp_refresh_rate));
    }

	//(re)loads the csv files, if necessary
	if (!simulated || initialize) {
		try {
			treatmentdata = fs.readFileSync(treatmentfile, 'utf-8');
		} catch (e) {
			console.log("Error reading treatment csv file")
		}
		try {
			cgmdata = fs.readFileSync(cgmfile, 'utf-8');
		} catch (e) {
			console.log("Error reading treatment csv file")
		}
	}
	initialize = false;

	var lines = treatmentdata.trim().split('\n');
	var latest = lines.length - 1;
	var mbg = [];
	var treatment = [];
	//Only get the most recent, valid treatment data points
	for (var i = latest; i > 0; i--) {
		lines[i] = lines[i].split(",");
		var t = new Date(lines[i][0]).getTime() + (9 - TZ_offset_hrs) * 3600 * 1000;
		if (t >= now - historyLength * 300 * 1000 && t < now) {
			mbg.unshift({ x: t, y: lines[i][2] });
			treatment.unshift({ x: t, y: lines[i][2], insulin: lines[i][1], carbs: lines[i][3], CR: lines[i][4] });
		}
	}
	//io.sockets.emit("treatment", treatment);

	// parse the csv file into lines
	var lines_with_duplicates = cgmdata.trim().split('\n');
	var lines = lines_with_duplicates.filter(function (elem, pos) {
		return lines_with_duplicates.indexOf(elem) == pos;
	})
	var latest = lines.length - 1;
	var actual = [];
	//Only get the most recent, valid sgv data points
	for (var i = latest; i > 0; i--) {
		lines[i] = lines[i].split(",");
		if (lines[i][0] > 10) {  //sgv less than or equal to 10 means error code; ignore
			var t = new Date(lines[i][1]).getTime() + (9 - TZ_offset_hrs) * 3600 * 1000;
			if (t >= now - historyLength * 300 * 1000 && t < now) {
				actual.unshift({ x: t, y: lines[i][0] });
			}
		}
	}

	
	var actual_len = actual.length - 1;
    //is there data to send to client?
	if (actual_len > 1) {
        //	Predict using AR model
	    var predicted = [];
	    var lastValidReadingTime = actual[actual_len].x;
	    var elapsed_min = (actual[actual_len].x - actual[actual_len - 1].x) / (60 * 1000);
	    var BG_REF = 140;
	    var y = Math.log(actual[actual_len].y / BG_REF);
	    if (elapsed_min < 5.1) {
	        y = [Math.log(actual[actual_len - 1].y / BG_REF), y];
	    } else {
	        y = [y, y];
	    }
	    var n = Math.ceil(12 * (1 / 2 + (now - lastValidReadingTime) / 3600 / 1000));   //Predict 1/2 hour ahead
	    var AR = [-0.723, 1.716];                   //AR calculation constants
	    var dt = actual[actual_len].x;
	    for (i = 0; i <= n; i++) {
	        y = [y[1], AR[0] * y[0] + AR[1] * y[1]];
	        dt = dt + 5 * 60 * 1000;
	        predicted[i] = {
	            x: dt,
	            y: Math.max(36, Math.min(400, Math.round(BG_REF * Math.exp(y[1]))))
	        };
	    }

	    //consolidate and send the data to the client
	    bgData = [actual, predicted, mbg, treatment];
	    io.sockets.emit("now", now)
	    io.sockets.emit("sgv", bgData);

	    //	compute current loss
	    var avgLoss = 0;
	    if (now > lastAckTime + 40 / 60 * 3600 * 1000) {
	        for (i = 0; i <= 6; i++) {
	            avgLoss += 1 / 6 * Math.pow(log10(predicted[i].y / 120), 2);
	        }
	        if (avgLoss > 0.10) {
	            io.sockets.emit('urgent_alarm');
	            //appendlog('urgent_alarm');
	        } else if (avgLoss > 0.05) {
	            io.sockets.emit('alarm');
	            //appendlog('alarm');
	        }
	    }
	}
}

var sensorReadID = setInterval(update, new refresh_rate);

io.set('log level', 0); // reduce logging
//Windows Azure Web Sites does not currently support WebSockets, so for long-polling
io.configure(function () {                
	io.set('transports', ['xhr-polling']);  
});

io.sockets.on('connection', function (socket) {
    console.log("client connected, refresh rate",new refresh_rate)
    //socket.emit("sgv", bgData);
    socket.on('simulated', function (val) {
        simulated = val;
        initialize = true;
        console.log('simulated = ', simulated)
        clearInterval(sensorReadID);
        sensorReadID = setInterval(update, new refresh_rate);
    })
    socket.on('ack', function (time) { lastAckTime = now; appendlog('ack') })
});

function log10(val) { return Math.log(val) / Math.LN10; }

function appendlog(message) {
	console.log(Date(now)+'\t'+message)
	fs.appendFile('log.csv', Date(now)+'\t'+message+'\n', encoding='utf8', function (err) {
		if (err) throw err;
	});
}