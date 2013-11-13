//basic web server to display data from Dexcom G4
//requires a small program which sits on the 
//Dexcom Studio DLL and creates a CSV file
//this program reads the csv file, parses it, then
//acts as a web server to display the current value
//Taken from Lane D.
var bgData = [];
var test = false;
var simulated = false;
var cgmfile = (simulated === true ? "hayden_oct.csv" : "hayden.csv");
var treatmentfile = (simulated === true ? "treatment_oct.csv" : "treatment.csv");
var now = (simulated === true ? Date.parse("10/22/2013 03:20:00") : new Date(now));

var port = process.env.PORT || 1337;
var refresh_rate = (test === true ? 0.1 : 1) * 60 * 1000;
refresh_rate = (simulated === true ? 0.1 * 60 * 1000 : refresh_rate) ;
console.log('refresh rate: ', refresh_rate)
var nodeStatic = require('node-static');
var fs = require('fs');
var staticServer = new nodeStatic.Server(".");
var TZ_offset_hrs = new Date().getTimezoneOffset()/60;  
var ftp = require("./ftp_credentials.json")
console.log(ftp)
//console.log(ftp.host)


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

//Default to 2 days
var historyLength = 60 * 24 * 2 / 5; //2 days

var clients = [];

//Initialize last ACK to 1 hour ago
var lastAckTime = 0;//Date.now() - 3600*1000;

//Grab csv from ftp site and store locally
var Client = require('ftp');
var c = new Client();
c.on('ready', function() {
  c.get(ftp.file, function(err, stream) {
    if (err) throw err;
    stream.setEncoding('utf8');
    stream.once('close', function() { c.end(); });
    stream.pipe(fs.createWriteStream('hayden.csv',{'flags':'w'}));  //append using 'a' flag
  });
});

// connect to FTP server to grab CSV and save it to Azure
setInterval(function() {
    c.connect({host: ftp.host, user: ftp.user, password: ftp.password});
}, Math.round(refresh_rate*0.9));

//Reloads the csv file
function update() {
    fs.readFile(cgmfile, 'utf-8', function fileReader(error, data) {
        if (error) {
            console.log("Error reading csv file.");
        } else {


            // parse the csv file into lines
            var lines_with_duplicates = data.trim().split('\n');
            //console.log('lwd: ', lines_with_duplicates);
            var lines = lines_with_duplicates.filter(function (elem, pos) {
                return lines_with_duplicates.indexOf(elem) == pos;
            })
            //console.log(lines)
            //console.log('duplicates data rows: ', lines_with_duplicates.length - lines.length)
            //console.log(lines_with_duplicates[1], lines[1])
            var latest = lines.length - 1;
            var actual = [];

            //may need to truncate the "actual" to end at the current now, for simulation purposes
            console.log('simulated: ', simulated, '  now: ', now, new Date(now))
            now = (simulated === true ? now + 5 * 60 * 1000 : Date.now());
            console.log('simulated: ', simulated, '  now: ', now, new Date(now))

            //Only get the most recent sgv data points
            console.log('latest - historyLength', latest - historyLength)
            for (var i = latest; i > 0; i--) {
                lines[i] = lines[i].split(",");
                if (lines[i][0] > 10) {
                    var t = new Date(lines[i][1]).getTime() + (9 - TZ_offset_hrs) * 3600 * 1000;
                    if (t >= now-historyLength*300*1000 && t < now) {
                        actual.unshift({ x: t, y: lines[i][0] });
                    }
                }
            }

            console.log("data timezone: ", new Date(lines[latest][1]).getTimezoneOffset() / 60, "  server timezone: ", TZ_offset_hrs);
            //console.log(actual)

            //Predict using AR model
            var predicted = [];
            var actual_len = actual.length - 1;
            var lastValidReadingTime = actual[actual_len].x;
            console.log('most recent data point: ', Date(actual[actual_len].x), actual[actual_len].y)



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

            //Remove measured points that don't lie within the time range
            console.log('historyLength:  ', historyLength)
            while (actual.length > 0 && actual[0].x < now - historyLength * 5 * 60 * 1000) { actual.shift(); }

            //console.log('oldest', bgData[0].x)

            bgData = [actual, predicted];
            io.sockets.emit("sgv", bgData);
            //console.log(bgData)


            io.sockets.emit("now", now)
            console.log("emitted now", now)
            var avgLoss = 0;
            console.log(Date(now), ' now');
            console.log(Date(lastAckTime + 40 / 60 * 3600 * 1000), ' 40 min from last ack');
            if (now > lastAckTime + 40 / 60 * 3600 * 1000) {
                for (i = 0; i <= 6; i++) {
                    avgLoss += 1 / 6 * Math.pow(log10(predicted[i].y / 120), 2);
                }
                console.log("The average loss is: " + Math.round(avgLoss * 100) / 100);
                if (avgLoss > 0.10) {
                    io.sockets.emit('urgent_alarm');
                    appendlog('urgent_alarm');
                } else if (avgLoss > 0.05) {
                    io.sockets.emit('alarm');
                    appendlog('alarm');
                }
            }
        }
    });
}

var sensorReadID = setInterval(update, refresh_rate);

io.set('log level', 0); // reduce logging
//Windows Azure Web Sites does not currently support WebSockets, so for long-polling
io.configure(function () {                
  io.set('transports', ['xhr-polling']);  
});                                       

io.sockets.on('connection', function (socket) {
    socket.emit("TZ", TZ_offset_hrs);
    socket.emit("sgv", bgData);
//    socket.on('update', function (data) {
//        appendlog('rescale');
//        console.log("updating time scale to " + data + " hours");
//        historyLength = data * 12;
//        update();
//    });
    socket.on('ack', function(time) { lastAckTime = now; appendlog('ack') }) //used to use 'time' but client / server time mismatch screwed this up
});

function log10(val) { return Math.log(val) / Math.LN10; }

function appendlog(message) {
    console.log(Date+'\t'+message)
    fs.appendFile('log.csv', Date()+'\t'+message+'\n', encoding='utf8', function (err) {
    if (err) throw err;
    });
}