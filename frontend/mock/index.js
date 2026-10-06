'use strict';

/**
 * 静态版引擎的 Node 侧聚合入口。
 *
 * 浏览器构建时，各模块会被拼接进同一作用域（共用全局变量）；
 * Node 侧则通过把各模块导出挂到 global 上来模拟同一个作用域，
 * 使同一份源码既能在浏览器里跑，也能在 Node 里做自动化测试。
 */

global.DATA = require('./data.js');

Object.assign(global, require('./core.js'));
Object.assign(global, require('./rules.js'));
Object.assign(global, require('./services.js'));
Object.assign(global, require('./routes.js'));

module.exports = {
  handle: global.handle,
  resetData: global.resetData,
  ROUTES: global.ROUTES,
  CODES: global.CODES,
  DEMO_SECRET: global.DEMO_SECRET,
};
