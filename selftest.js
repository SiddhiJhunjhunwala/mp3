// Local end-to-end checks for the API.
// Usage: node selftest.js [baseUrl]    (default http://localhost:3000)
// Creates its own test users/tasks and deletes them at the end.

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '') + '/api';
let passed = 0, failed = 0;
const created = { users: [], tasks: [] };

async function call(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json };
}

function check(name, cond, extra) {
    if (cond) { passed++; }
    else { failed++; console.log('FAIL:', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

const q = (o) => encodeURIComponent(JSON.stringify(o));
const uid = Date.now().toString(36);
const DEADLINE = '2030-01-01T00:00:00.000Z';

async function user(name, extra = {}) {
    const r = await call('POST', '/users', { name, email: `${name}.${uid}@test.com`, ...extra });
    if (r.status === 201) created.users.push(r.body.data._id);
    return r;
}
async function task(name, extra = {}) {
    const r = await call('POST', '/tasks', { name, deadline: DEADLINE, ...extra });
    if (r.status === 201) created.tasks.push(r.body.data._id);
    return r;
}
const getU = async (id) => (await call('GET', '/users/' + id)).body.data;
const getT = async (id) => (await call('GET', '/tasks/' + id)).body.data;

async function main() {
    // ---------- create & validate ----------
    let r = await user('alice');
    check('POST user 201', r.status === 201, r);
    const alice = r.body.data;
    check('user defaults', Array.isArray(alice.pendingTasks) && alice.pendingTasks.length === 0 && alice.dateCreated, alice);
    check('envelope', typeof r.body.message === 'string');

    r = await call('POST', '/users', { name: 'x' });
    check('user missing email 400', r.status === 400, r);
    r = await call('POST', '/users', { email: 'x' + uid + '@a.com' });
    check('user missing name 400', r.status === 400, r);
    r = await call('POST', '/users', { name: 'dup', email: alice.email });
    check('duplicate email 400', r.status === 400, r);
    r = await call('POST', '/users', { name: 'bad', email: 'b' + uid + '@a.com', pendingTasks: ['nope'] });
    check('bad pendingTasks id 400', r.status === 400, r);
    r = await call('POST', '/users', { name: 'bad', email: 'c' + uid + '@a.com', pendingTasks: ['000000000000000000000000'] });
    check('missing pendingTasks task 404', r.status === 404, r);
    r = await call('POST', '/users', '{bad json');
    check('bad JSON body 400', r.status === 400 && r.body && r.body.message, r);

    r = await task('t1');
    check('POST task 201', r.status === 201, r);
    const t1 = r.body.data;
    check('task defaults', t1.description === '' && t1.completed === false && t1.assignedUser === '' &&
        t1.assignedUserName === 'unassigned' && t1.dateCreated, t1);
    r = await call('POST', '/tasks', { name: 'x' });
    check('task missing deadline 400', r.status === 400, r);
    r = await call('POST', '/tasks', { deadline: DEADLINE });
    check('task missing name 400', r.status === 400, r);
    r = await call('POST', '/tasks', { name: 'x', deadline: 'not a date' });
    check('task bad deadline 400', r.status === 400, r);
    r = await call('POST', '/tasks', { name: 'x', deadline: DEADLINE, assignedUser: 'abc' });
    check('task bad assignedUser 400', r.status === 400, r);
    r = await call('POST', '/tasks', { name: 'x', deadline: DEADLINE, assignedUser: '000000000000000000000000' });
    check('task missing assignedUser 404', r.status === 404, r);
    r = await call('POST', '/tasks', { name: 'x', deadline: DEADLINE, assignedUser: alice._id, assignedUserName: 'wrong' });
    check('task name mismatch 400', r.status === 400, r);
    r = await call('POST', '/tasks', { name: 'x', deadline: DEADLINE, completed: 'maybe' });
    check('task bad completed 400', r.status === 400, r);

    // POST task assigned to alice
    r = await task('t2', { assignedUser: alice._id });
    check('POST assigned task 201', r.status === 201 && r.body.data.assignedUserName === 'alice', r);
    const t2 = r.body.data;
    check('alice has t2', (await getU(alice._id)).pendingTasks.includes(t2._id));

    // POST completed assigned task -> not in pending
    r = await task('t3', { assignedUser: alice._id, assignedUserName: 'alice', completed: true });
    const t3 = r.body.data;
    check('completed task not pending', !(await getU(alice._id)).pendingTasks.includes(t3._id));

    // ---------- select ----------
    r = await call('GET', `/users/${alice._id}?select=${q({ name: 1 })}`);
    check('select include on /users/:id', r.status === 200 && r.body.data.name === 'alice' && r.body.data.email === undefined, r);
    r = await call('GET', `/tasks/${t1._id}?select=${q({ _id: 0, name: 0 })}`);
    check('select exclude on /tasks/:id', r.status === 200 && r.body.data._id === undefined && r.body.data.name === undefined && r.body.data.deadline, r);
    r = await call('GET', `/tasks/${t1._id}?where=${q({ name: 'zzz' })}`);
    check('/tasks/:id ignores where', r.status === 200 && r.body.data._id === t1._id, r);
    r = await call('GET', '/users/notanid');
    check('GET bad id 404', r.status === 404, r);
    r = await call('GET', '/users/000000000000000000000000');
    check('GET missing id 404', r.status === 404, r);
    r = await call('GET', `/users/${alice._id}?select={bad`);
    check('bad select JSON 400', r.status === 400, r);

    // ---------- query params ----------
    r = await call('GET', `/tasks?where=${q({ _id: { $in: [t1._id, t2._id, t3._id] } })}&sort=${q({ name: -1 })}`);
    check('where $in + sort', r.status === 200 && r.body.data.map(t => t.name).join() === 't3,t2,t1', r.body);
    r = await call('GET', `/tasks?where=${q({ _id: { $in: [t1._id, t2._id, t3._id] }, completed: true })}`);
    check('where completed', r.body.data.length === 1 && r.body.data[0]._id === t3._id, r.body);
    r = await call('GET', `/tasks?where=${q({ _id: { $in: [t1._id, t2._id, t3._id] } })}&count=true`);
    check('count', r.status === 200 && r.body.data === 3, r.body);
    r = await call('GET', `/tasks?where=${q({ _id: { $in: [t1._id, t2._id, t3._id] } })}&sort=${q({ name: 1 })}&skip=1&limit=1`);
    check('skip+limit', r.body.data.length === 1 && r.body.data[0].name === 't2', r.body);
    r = await call('GET', `/users?where=${q({ _id: '000000000000000000000000' })}`);
    check('where no match 200 []', r.status === 200 && Array.isArray(r.body.data) && r.body.data.length === 0, r);
    r = await call('GET', `/users?select=${q({ _id: 0 })}&limit=2`);
    check('select on list', r.status === 200 && r.body.data.every(x => x._id === undefined), r.body);
    r = await call('GET', '/tasks?where={nope');
    check('bad where JSON 400', r.status === 400, r);
    r = await call('GET', '/tasks?limit=abc');
    check('bad limit 400', r.status === 400, r);
    r = await call('GET', '/tasks');
    check('default task limit <= 100', r.status === 200 && r.body.data.length <= 100);

    // ---------- PUT missing ----------
    r = await call('PUT', '/users/000000000000000000000000', { name: 'a', email: 'zz' + uid + '@a.com' });
    check('PUT missing user 404', r.status === 404, r);
    r = await call('PUT', '/users/garbage', { name: 'a' });
    check('PUT bad-id user 404 (before 400)', r.status === 404, r);
    r = await call('PUT', '/tasks/000000000000000000000000', { name: 'a', deadline: DEADLINE });
    check('PUT missing task 404', r.status === 404, r);

    // ---------- two-way refs ----------
    const bob = (await user('bob')).body.data;

    // PUT task t1 -> bob
    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: DEADLINE, assignedUser: bob._id });
    check('PUT task assign 200', r.status === 200 && r.body.data.assignedUserName === 'bob', r);
    check('bob has t1', (await getU(bob._id)).pendingTasks.includes(t1._id));

    // PUT task t1 -> alice (move)
    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: DEADLINE, assignedUser: alice._id, assignedUserName: 'alice' });
    check('move task', r.status === 200, r);
    check('bob lost t1', !(await getU(bob._id)).pendingTasks.includes(t1._id));
    check('alice got t1', (await getU(alice._id)).pendingTasks.includes(t1._id));

    // complete t1
    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: DEADLINE, completed: true, assignedUser: alice._id });
    check('complete task 200', r.status === 200 && r.body.data.assignedUser === alice._id, r);
    check('completed removed from pending', !(await getU(alice._id)).pendingTasks.includes(t1._id));

    // uncomplete t1
    await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: DEADLINE, completed: false, assignedUser: alice._id });
    check('uncompleted back in pending', (await getU(alice._id)).pendingTasks.includes(t1._id));

    // unassign t1
    r = await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: DEADLINE, assignedUser: '' });
    check('unassign', r.body.data.assignedUserName === 'unassigned', r);
    check('unassigned removed', !(await getU(alice._id)).pendingTasks.includes(t1._id));

    // PUT task with mismatched name: rejected and nothing changes
    r = await call('PUT', '/tasks/' + t2._id, { name: 'changed', deadline: DEADLINE, assignedUser: bob._id, assignedUserName: 'alice' });
    check('PUT mismatch 400', r.status === 400, r);
    check('failed PUT changed nothing', (await getT(t2._id)).name === 't2' && (await getT(t2._id)).assignedUser === alice._id);

    // PUT task: missing fields reset to defaults, dateCreated kept
    const before = await getT(t2._id);
    r = await call('PUT', '/tasks/' + t2._id, { name: 't2', deadline: DEADLINE, dateCreated: '2000-01-01' });
    check('PUT task defaults', r.body.data.description === '' && r.body.data.assignedUser === '' && r.body.data.dateCreated === before.dateCreated, r.body);
    check('alice lost t2 after unassign-by-omission', !(await getU(alice._id)).pendingTasks.includes(t2._id));

    // PUT user with pendingTasks: take t2 (unassigned) and t1
    r = await call('PUT', '/users/' + bob._id, { name: 'bob', email: bob.email, pendingTasks: [t1._id, t2._id] });
    check('PUT user pendingTasks 200', r.status === 200 && r.body.data.pendingTasks.length === 2, r);
    check('t1 -> bob', (await getT(t1._id)).assignedUser === bob._id && (await getT(t1._id)).assignedUserName === 'bob');

    // alice steals t1 via PUT user
    const aliceNow = await getU(alice._id);
    r = await call('PUT', '/users/' + alice._id, { name: 'alice', email: alice.email, pendingTasks: [t1._id] });
    check('steal via PUT user', r.status === 200);
    check('bob lost t1 (steal)', !(await getU(bob._id)).pendingTasks.includes(t1._id));
    check('t1 -> alice', (await getT(t1._id)).assignedUser === alice._id);
    for (const id of aliceNow.pendingTasks.filter(id => id !== t1._id)) {
        check('alice old pending unassigned', (await getT(id)).assignedUser === '');
    }

    // completed task in pendingTasks -> 400
    r = await call('PUT', '/users/' + alice._id, { name: 'alice', email: alice.email, pendingTasks: [t3._id] });
    check('completed in pendingTasks 400', r.status === 400, r);
    check('failed user PUT changed nothing', (await getU(alice._id)).pendingTasks.includes(t1._id));

    // email of another user -> 400 ; own email fine
    r = await call('PUT', '/users/' + alice._id, { name: 'alice', email: bob.email });
    check('PUT user dup email 400', r.status === 400, r);

    // rename alice -> all her tasks (incl. completed t3) renamed; empty pendingTasks unassigns t1
    r = await call('PUT', '/users/' + alice._id, { name: 'alicia', email: alice.email });
    check('rename 200', r.status === 200 && r.body.data.pendingTasks.length === 0 && r.body.data.dateCreated === alice.dateCreated, r.body);
    check('completed task renamed', (await getT(t3._id)).assignedUserName === 'alicia');
    check('t1 unassigned by omission', (await getT(t1._id)).assignedUser === '');

    // ---------- delete ----------
    // give bob t1 again then delete t1
    await call('PUT', '/tasks/' + t1._id, { name: 't1', deadline: DEADLINE, assignedUser: bob._id });
    r = await call('DELETE', '/tasks/' + t1._id);
    check('DELETE task 200', r.status === 200, r);
    created.tasks = created.tasks.filter(x => x !== t1._id);
    check('deleted task gone', (await call('GET', '/tasks/' + t1._id)).status === 404);
    check('deleted task removed from user', !(await getU(bob._id)).pendingTasks.includes(t1._id));
    check('DELETE again 404', (await call('DELETE', '/tasks/' + t1._id)).status === 404);

    // delete alicia -> t3 (completed) unassigned
    r = await call('DELETE', '/users/' + alice._id);
    check('DELETE user 200', r.status === 200, r);
    created.users = created.users.filter(x => x !== alice._id);
    check('deleted user gone', (await call('GET', '/users/' + alice._id)).status === 404);
    const t3n = await getT(t3._id);
    check('user delete unassigns completed task', t3n.assignedUser === '' && t3n.assignedUserName === 'unassigned', t3n);
    check('DELETE bad id 404', (await call('DELETE', '/users/xyz')).status === 404);

    // cleanup
    for (const id of created.tasks) await call('DELETE', '/tasks/' + id);
    for (const id of created.users) await call('DELETE', '/users/' + id);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
