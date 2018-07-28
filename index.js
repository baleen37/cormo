if (process.env.CORMO_COVERAGE === 'true') {
  require('coffee-coverage').register({
    path: 'relative',
    basePath: __dirname + '/src',
    exclude: ['/test']
  });
  module.exports = require('./src');
} else {
  module.exports = require('./lib');
}
