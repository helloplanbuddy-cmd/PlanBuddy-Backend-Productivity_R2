'use strict';

/**
 * middleware/apiVersion.js — API Version Header Setter (v3.0)
 *
 * Classification: ✅ KEEP — correct and unchanged from v2.0.
 * Sets X-API-Version header on all responses and attaches version to req.
 */

function apiVersion(version) {
  return (req, res, next) => {
    req.apiVersion = version;
    res.setHeader('X-API-Version', version);
    next();
  };
}

module.exports = apiVersion;
