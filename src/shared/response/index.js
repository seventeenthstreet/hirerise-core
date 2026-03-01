'use strict';

/**
 * Standard success response wrapper
 */
exports.successResponse = (data, message = 'Success') => {
  return {
    success: true,
    message,
    data,
  };
};

/**
 * Standard error response wrapper
 */
exports.errorResponse = (message = 'Something went wrong') => {
  return {
    success: false,
    message,
  };
};
