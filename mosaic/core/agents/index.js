'use strict';

module.exports = {
  ...require('./registry'),
  ...require('./detect'),
  ...require('./args'),
  ...require('./spawn')
};
