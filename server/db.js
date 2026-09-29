'use strict';

/**
 * 数据访问层：MySQL 连接池与事务封装（见设计文档 2.1 三层架构）。
 */

const mysql = require('mysql2/promise');
const config = require('../config/config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  charset: config.db.charset,
  dateStrings: false,
  timezone: 'local',
});

/** 执行查询，返回结果行数组 */
async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

/** 查询单行，无结果返回 null */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** 执行写操作，返回 { affectedRows, insertId } */
async function execute(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return result;
}

/**
 * 事务封装。回调收到 connection，请使用 conn.query 执行语句。
 * 任一步抛错则整体回滚（用于换课"先占后放"等需要原子性的场景）。
 */
async function withTransaction(handler) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await handler(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      /* 回滚失败时忽略，交由上层返回错误 */
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

module.exports = { pool, query, queryOne, execute, withTransaction, ping };
