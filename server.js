// Get the packages we need
var express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose');

// Read .env file
require('dotenv').config();

var ApiError = require('./routes/utils').ApiError;

// Create our Express application
var app = express();

// Use environment defined port or 3000
var port = process.env.PORT || 3000;

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI).catch(function (err) { console.error('MongoDB connection error:', err.message); });

// Allow CORS so that backend and frontend could be put on different servers
var allowCrossDomain = function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
};
app.use(allowCrossDomain);

// Parse URL-encoded and JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Use routes as a module (see index.js)
require('./routes')(app, router);

// Unknown routes
app.use(function (req, res) {
    res.status(404).json({ message: 'Endpoint not found', data: null });
});

// Errors: never leak Mongoose/MongoDB details to the client
// eslint-disable-next-line no-unused-vars
app.use(function (err, req, res, next) {
    if (err instanceof ApiError) {
        return res.status(err.status).json({ message: err.message, data: err.data });
    }
    if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
        return res.status(400).json({ message: 'The request body is not valid JSON', data: null });
    }
    if (err && (err.name === 'ValidationError' || err.name === 'CastError')) {
        return res.status(400).json({ message: 'The request contains invalid values', data: null });
    }
    console.error(err);
    res.status(500).json({ message: 'Something went wrong on the server. Please try again later.', data: null });
});

// Start the server
app.listen(port);
console.log('Server running on port ' + port);
