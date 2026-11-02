/*
 * Shared helpers for the users and tasks routes.
 */

// An error that maps directly to an HTTP response.
class ApiError extends Error {
    constructor(status, message, data) {
        super(message);
        this.status = status;
        this.data = data === undefined ? null : data;
    }
}

function send(res, status, message, data) {
    return res.status(status).json({ message: message, data: data === undefined ? null : data });
}

// A MongoDB ObjectId in its 24-hex-character string form.
var OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
function isObjectId(value) {
    return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Parse one JSON-encoded query string parameter (where / sort / select).
function parseJsonParam(query, name) {
    var raw = query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string') {
        throw new ApiError(400, 'The "' + name + '" parameter must be given once, as JSON');
    }
    var parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new ApiError(400, 'The "' + name + '" parameter is not valid JSON');
    }
    if (!isPlainObject(parsed)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a JSON object');
    }
    return parsed;
}

// Parse a non-negative integer query parameter (skip / limit).
function parseIntParam(query, name) {
    var raw = query[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !/^\s*\d+\s*$/.test(raw)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a non-negative integer');
    }
    return parseInt(raw, 10);
}

function parseBoolParam(query, name) {
    var raw = query[name];
    if (raw === undefined) return false;
    if (typeof raw !== 'string') {
        throw new ApiError(400, 'The "' + name + '" parameter must be true or false');
    }
    var v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') return true;
    if (v === 'false' || v === '0' || v === '') return false;
    throw new ApiError(400, 'The "' + name + '" parameter must be true or false');
}

/*
 * GET on a collection: where, sort, select, skip, limit, count.
 * All filtering is done by MongoDB through Mongoose query methods.
 */
async function listCollection(Model, req, res, options) {
    var where = parseJsonParam(req.query, 'where') || {};
    var sort = parseJsonParam(req.query, 'sort');
    var select = parseJsonParam(req.query, 'select');
    var skip = parseIntParam(req.query, 'skip');
    var limit = parseIntParam(req.query, 'limit');
    var count = parseBoolParam(req.query, 'count');

    try {
        if (count) {
            var countQuery = Model.countDocuments(where);
            if (skip !== undefined) countQuery = countQuery.skip(skip);
            if (limit !== undefined && limit > 0) countQuery = countQuery.limit(limit);
            var n = await countQuery.exec();
            return send(res, 200, 'OK', n);
        }

        var query = Model.find(where);
        if (sort) query = query.sort(sort);
        if (select) query = query.select(select);
        if (skip !== undefined) query = query.skip(skip);
        if (limit === undefined) limit = options.defaultLimit;
        if (limit !== undefined && limit > 0) query = query.limit(limit);

        var docs = await query.lean().exec();
        return send(res, 200, 'OK', docs);
    } catch (err) {
        throw queryError(err);
    }
}

// GET on a single resource: only "select" applies.
async function getOne(Model, label, req, res) {
    var id = req.params.id;
    if (!isObjectId(id)) throw new ApiError(404, label + ' not found');
    var select = parseJsonParam(req.query, 'select');

    var doc;
    try {
        var query = Model.findById(id);
        if (select) query = query.select(select);
        doc = await query.lean().exec();
    } catch (err) {
        throw queryError(err);
    }
    if (!doc) throw new ApiError(404, label + ' not found');
    return send(res, 200, 'OK', doc);
}

// A failure caused by the client's query (bad operator, bad cast, mixed projection...)
// is a 400; anything else is a server error. Never leak driver messages.
function queryError(err) {
    if (err instanceof ApiError) return err;
    var name = err && err.name;
    if (name === 'CastError' || name === 'StrictModeError' ||
        (name === 'MongoServerError' && err.code !== undefined && err.code !== 11000 &&
            !/network|timeout/i.test(err.message || ''))) {
        return new ApiError(400, 'The query parameters are invalid');
    }
    return err;
}

/* ----- body field validation ----- */

function requiredString(body, field, label) {
    var v = body[field];
    if (v === undefined || v === null) throw new ApiError(400, label + ' is required');
    if (typeof v !== 'string') throw new ApiError(400, label + ' must be a string');
    if (v.trim() === '') throw new ApiError(400, label + ' is required');
    return v;
}

function optionalString(body, field, label, fallback) {
    var v = body[field];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string') throw new ApiError(400, label + ' must be a string');
    return v;
}

function parseDate(value, label) {
    if (value === undefined || value === null || value === '') {
        throw new ApiError(400, label + ' is required');
    }
    var d;
    if (typeof value === 'number') {
        d = new Date(value);
    } else if (typeof value === 'string') {
        var s = value.trim();
        d = /^-?\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
    } else {
        throw new ApiError(400, label + ' must be a date');
    }
    if (isNaN(d.getTime())) throw new ApiError(400, label + ' must be a valid date');
    return d;
}

function parseBoolean(value, label, fallback) {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        var v = value.trim().toLowerCase();
        if (v === 'true') return true;
        if (v === 'false') return false;
    }
    throw new ApiError(400, label + ' must be true or false');
}

module.exports = {
    ApiError: ApiError,
    send: send,
    isObjectId: isObjectId,
    isPlainObject: isPlainObject,
    listCollection: listCollection,
    getOne: getOne,
    requiredString: requiredString,
    optionalString: optionalString,
    parseDate: parseDate,
    parseBoolean: parseBoolean
};
