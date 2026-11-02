var User = require('../models/user');
var Task = require('../models/task');
var u = require('./utils');
var ApiError = u.ApiError;

function readTaskBody(req) {
    var body = req.body || {};
    if (!u.isPlainObject(body)) throw new ApiError(400, 'The request body must be a JSON object');

    var name = u.requiredString(body, 'name', 'Name');
    var deadline = u.parseDate(body.deadline, 'Deadline');
    var description = u.optionalString(body, 'description', 'Description', '');
    var completed = u.parseBoolean(body.completed, 'Completed', false);

    var assignedUser = u.optionalString(body, 'assignedUser', 'assignedUser', '').trim();
    if (assignedUser !== '' && !u.isObjectId(assignedUser)) {
        throw new ApiError(400, 'assignedUser is not a valid user id');
    }
    var assignedUserName = u.optionalString(body, 'assignedUserName', 'assignedUserName', undefined);

    return {
        name: name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

/*
 * Shared by POST /tasks and PUT /tasks/:id. `existing` is the current task
 * document for a PUT, or null for a POST. All checks happen before any write.
 */
async function saveTask(req, existing) {
    // 400: field format and values
    var input = readTaskBody(req);

    var user = null;
    if (input.assignedUser === '') {
        // Unassigned: a name, if given, must say so.
        if (input.assignedUserName !== undefined &&
            input.assignedUserName !== '' && input.assignedUserName !== 'unassigned') {
            throw new ApiError(400, 'assignedUserName is set but assignedUser is not');
        }
        input.assignedUserName = 'unassigned';
    } else {
        // 404: the user must exist
        user = await User.findById(input.assignedUser);
        if (!user) throw new ApiError(404, 'The assigned user does not exist');
        // 400: name must match that user
        if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) {
            throw new ApiError(400, 'assignedUserName does not match the name of the assigned user');
        }
        input.assignedUserName = user.name;
    }

    // --- all checks passed; write ---
    var previousUser = existing ? existing.assignedUser : '';
    var task = existing || new Task();
    task.name = input.name;
    task.description = input.description;
    task.deadline = input.deadline;
    task.completed = input.completed;
    task.assignedUser = input.assignedUser;
    task.assignedUserName = input.assignedUserName;
    await task.save();
    var taskId = task._id.toString();

    // Leaving the previous user.
    if (previousUser && previousUser !== input.assignedUser && u.isObjectId(previousUser)) {
        await User.updateOne({ _id: previousUser }, { $pull: { pendingTasks: taskId } });
    }

    if (user) {
        if (task.completed) {
            await User.updateOne({ _id: user._id }, { $pull: { pendingTasks: taskId } });
        } else {
            await User.updateOne({ _id: user._id }, { $addToSet: { pendingTasks: taskId } });
        }
    }

    // Safety net: no other user may list this task.
    await User.updateMany(
        { pendingTasks: taskId, _id: { $ne: user ? user._id : null } },
        { $pull: { pendingTasks: taskId } }
    );

    return task.toObject();
}

async function findTaskOr404(id) {
    if (!u.isObjectId(id)) throw new ApiError(404, 'Task not found');
    var task = await Task.findById(id);
    if (!task) throw new ApiError(404, 'Task not found');
    return task;
}

module.exports = function (router) {

    router.route('/tasks')
        .get(async function (req, res) {
            await u.listCollection(Task, req, res, { defaultLimit: 100 });
        })
        .post(async function (req, res) {
            var task = await saveTask(req, null);
            u.send(res, 201, 'Task created', task);
        });

    router.route('/tasks/:id')
        .get(async function (req, res) {
            await u.getOne(Task, 'Task', req, res);
        })
        .put(async function (req, res) {
            var existing = await findTaskOr404(req.params.id);
            var task = await saveTask(req, existing);
            u.send(res, 200, 'Task updated', task);
        })
        .delete(async function (req, res) {
            var task = await findTaskOr404(req.params.id);
            var taskId = task._id.toString();
            await Task.deleteOne({ _id: task._id });
            await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } });
            res.status(204).end();
        });

    return router;
};
