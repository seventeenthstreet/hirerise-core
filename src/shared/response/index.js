'use strict';

/**
 * @file src/shared/response/index.js
 * @description
 * Standard API response helpers.
 * Production-safe, immutable, and frontend-friendly.
 */

/**
 * Standard success response wrapper
 *
 * @param {*} data
 * @param {string} [message='Success']
 * @param {object|null} [meta=null]
 * @returns {{success:boolean,message:string,data:*,meta?:object}}
 */
function successResponse(data = null, message = 'Success', meta = null) {
  const response = {
    success: true,
    message,
    data,
  };

  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    response.meta = meta;
  }

  return response;
}

/**
 * Standard error response wrapper
 *
 * @param {string} [message='Something went wrong']
 * @param {string|null} [code=null]
 * @param {object|null} [details=null]
 * @returns {{success:boolean,message:string,error?:object}}
 */
function errorResponse(
  message = 'Something went wrong',
  code = null,
  details = null
) {
  const response = {
    success: false,
    message,
  };

  if (code || details) {
    response.error = {
      ...(code && { code }),
      ...(details &&
        typeof details === 'object' &&
        !Array.isArray(details) && { details }),
    };
  }

  return response;
}

module.exports = Object.freeze({
  successResponse,
  errorResponse,
});