module.exports = function (router) {

    var homeRoute = router.route('/');

    homeRoute.get(function (req, res) {
        res.json({ message: 'Llama.io API is running', data: { endpoints: ['/api/users', '/api/tasks'] } });
    });

    return router;
}
