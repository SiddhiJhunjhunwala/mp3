var User = require('../models/user');
var Task = require('../models/task');
var u = require('./utils');
var ApiError = u.ApiError;

var EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/*
 * Read pendingTasks from the body. JSON bodies must send a list; form-encoded
 * bodies send a single value as a plain string, so that is accepted there.
 */
function readPendingTasks(req) {
    var v = req.body.pendingTasks;
    if (v === undefined || v === null) return [];
    if (typeof v === 'string' && req.is('application/x-www-form-urlencoded')) {
        var s = v.trim();
        if (s === '') return [];
        if (s[0] === '[') {
            try { v = JSON.parse(s); } catch (e) { throw new ApiError(400, 'pendingTasks must be a list of task ids'); }
        } else {
            v = [s];
        }
    }
    if (!Array.isArray(v)) throw new ApiError(400, 'pendingTasks must be a list of task ids');
    var seen = {};
    var ids = [];
    v.forEach(function (id) {
        if (!u.isObjectId(id)) throw new ApiError(400, 'pendingTasks contains an invalid task id');
        if (!seen[id]) { seen[id] = true; ids.push(id); }
    });
    return ids;
}

function readUserBody(req) {
    var body = req.body || {};
    if (!u.isPlainObject(body)) throw new ApiError(400, 'The request body must be a JSON object');
    var name = u.requiredString(body, 'name', 'Name');
    var email = u.requiredString(body, 'email', 'Email').trim();
    if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Email is not a valid email address');
    var pendingTasks = readPendingTasks(req);
    return { name: name, email: email, pendingTasks: pendingTasks };
}

/*
 * Shared by POST /users and PUT /users/:id. `existing` is the current user
 * document for a PUT, or null for a POST. Everything is validated before
 * anything is written, so a failed request changes nothing.
 */
async function saveUser(req, existing) {
    // 400: field format and values
    var input = readUserBody(req);

    var emailQuery = { email: input.email };
    if (existing) emailQuery._id = { $ne: existing._id };
    if (await User.exists(emailQuery)) {
        throw new ApiError(400, 'A user with this email already exists');
    }

    // 404: referenced tasks must exist
    var tasks = input.pendingTasks.length
        ? await Task.find({ _id: { $in: input.pendingTasks } }).lean()
        : [];
    if (tasks.length !== input.pendingTasks.length) {
        throw new ApiError(404, 'One or more tasks in pendingTasks do not exist');
    }
    // 400: completed tasks can't be pending
    if (tasks.some(function (t) { return t.completed; })) {
        throw new ApiError(400, 'A completed task cannot be in pendingTasks');
    }

    // --- all checks passed; write ---
    var user = existing || new User();
    user.name = input.name;
    user.email = input.email;
    user.pendingTasks = input.pendingTasks;
    try {
        await user.save();
    } catch (err) {
        if (err && err.code === 11000) throw new ApiError(400, 'A user with this email already exists');
        throw err;
    }
    var userId = user._id.toString();

    // Pending tasks of this user that are no longer listed become unassigned.
    await Task.updateMany(
        { assignedUser: userId, completed: false, _id: { $nin: input.pendingTasks } },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );

    if (input.pendingTasks.length) {
        // Tasks taken over from other users leave those users' pendingTasks.
        await User.updateMany(
            { _id: { $ne: user._id }, pendingTasks: { $in: input.pendingTasks } },
            { $pull: { pendingTasks: { $in: input.pendingTasks } } }
        );
        await Task.updateMany(
            { _id: { $in: input.pendingTasks } },
            { $set: { assignedUser: userId, assignedUserName: user.name } }
        );
    }

    // Keep the name current on every task still assigned to this user (completed too).
    if (existing) {
        await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: user.name } });
    }

    return user.toObject();
}

async function findUserOr404(id) {
    if (!u.isObjectId(id)) throw new ApiError(404, 'User not found');
    var user = await User.findById(id);
    if (!user) throw new ApiError(404, 'User not found');
    return user;
}

module.exports = function (router) {

    router.route('/users')
        .get(async function (req, res) {
            await u.listCollection(User, req, res, { defaultLimit: undefined });
        })
        .post(async function (req, res) {
            var user = await saveUser(req, null);
            u.send(res, 201, 'User created', user);
        });

    router.route('/users/:id')
        .get(async function (req, res) {
            await u.getOne(User, 'User', req, res);
        })
        .put(async function (req, res) {
            var existing = await findUserOr404(req.params.id);
            var user = await saveUser(req, existing);
            u.send(res, 200, 'User updated', user);
        })
        .delete(async function (req, res) {
            var user = await findUserOr404(req.params.id);
            var userId = user._id.toString();
            await User.deleteOne({ _id: user._id });
            await Task.updateMany(
                { assignedUser: userId },
                { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
            );
            u.send(res, 200, 'User deleted', user.toObject());
        });

    return router;
};
