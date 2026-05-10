'use strict';

/**
 * controllers/authController.js — Authentication Controller (Production)
 *
 * Changes from original:
 *  - generateToken now returns { token, jti } (not just a string)
 *  - Logout revokes the JTI in the DB blacklist
 *  - changePassword revokes the current token after success
 *  - Account lockout: 5 failed logins → 15-minute lock
 *  - All sensitive mutations logged to audit_log
 */

// PHASE 4.1: Use bcryptQueue for threadpool protection
// Fallback to bcryptjs if queue fails
let bcrypt;
try {
  bcrypt = require('../services/bcryptQueue');
} catch (_) {
  // Queue not available - fallback to sync bcrypt
  bcrypt = require('bcryptjs');
}
const { generateToken, revokeToken, revokeAllUserTokens, decodeToken } = require('../utils/jwt');
const RefreshTokenService  = require('../services/refreshTokenService');
const AuditService         = require('../services/auditService');
const db                   = require('../config/db');
const { redis }            = require('../config/redis');
const env                  = require('../config/env');
const logger               = require('../utils/logger');

const BCRYPT_ROUNDS     = 12;
const MAX_PASSWORD_LEN  = 72;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES   = 15;

// ─── POST /auth/register ─────────────────────────────────────────────────────
exports.register = async (req, res, next) => {
  try {
    const { email, password, name, phone, role = 'user' } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ success: false, message: 'name, email, and password are required' });
    }
    if (password.length < 8)              return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
    if (password.length > MAX_PASSWORD_LEN) return res.status(400).json({ success: false, message: 'Password must be 72 characters or fewer' });

    const allowedRoles    = ['user', 'agency'];
    const safeRole        = allowedRoles.includes(role) ? role : 'user';
    const normalizedEmail = email.toLowerCase().trim();

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ success: false, message: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await db.query(
      `INSERT INTO users (email, password_hash, name, phone, role, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, email, name, phone, role, created_at`,
      [normalizedEmail, passwordHash, name.trim(), phone || null, safeRole]
    );

    const user = result.rows[0];
    const { token } = generateToken({ id: user.id, role: user.role });
    const refresh = await RefreshTokenService.createRefreshToken(user.id, redis, {
      ip: req.ip,
      userAgent: req.get('User-Agent') || null,
      device: req.get('User-Agent') || null,
    });

    AuditService.log({ action: AuditService.ACTIONS.USER_REGISTERED, entityType: 'user', entityId: user.id, req });
    logger.info('New user registered', { userId: user.id, role: user.role });

    res.status(201).json({
      success: true,
      message: 'Account created successfully',
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        token,
        accessToken: token,
        refreshToken: refresh.refreshToken,
        expiresIn: env.JWT_EXPIRY,
        refreshExpiresIn: env.REFRESH_TOKEN_EXPIRY,
      },
    });
  } catch (err) { next(err); }
};

// ─── POST /auth/login ────────────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ success: false, message: 'Email and password are required' });
    if (password.length > MAX_PASSWORD_LEN) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    const normalizedEmail = email.toLowerCase().trim();
    const userResult = await db.query(
      'SELECT id, email, password_hash, role, failed_login_attempts, locked_until, is_active FROM users WHERE email = $1',
      [normalizedEmail]
    );

    // Constant-time dummy to prevent user enumeration
    if (userResult.rows.length === 0) {
      await bcrypt.hash(password, BCRYPT_ROUNDS);
      AuditService.log({ action: AuditService.ACTIONS.USER_LOGIN_FAILED, entityType: 'user', req });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: 'Account deactivated. Please contact support.' });
    }

    // Account lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const waitMins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({ success: false, message: `Account locked due to too many failed attempts. Try again in ${waitMins} minutes.` });
    }

    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      const newAttempts = user.failed_login_attempts + 1;
      const lockedUntil = newAttempts >= MAX_FAILED_LOGINS ? `NOW() + INTERVAL '${LOCKOUT_MINUTES} minutes'` : 'NULL';
      await db.query(
        `UPDATE users SET failed_login_attempts = $1, locked_until = ${lockedUntil} WHERE id = $2`,
        [newAttempts, user.id]
      );
      if (newAttempts >= MAX_FAILED_LOGINS) {
        AuditService.log({ action: AuditService.ACTIONS.USER_LOCKED, entityType: 'user', entityId: user.id, req });
      }
      AuditService.log({ action: AuditService.ACTIONS.USER_LOGIN_FAILED, entityType: 'user', entityId: user.id, req });
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Reset failed attempts on successful login
    if (user.failed_login_attempts > 0) {
      await db.query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
    }

    const { token } = generateToken({ id: user.id, role: user.role });
    const refresh = await RefreshTokenService.createRefreshToken(user.id, redis, {
      ip: req.ip,
      userAgent: req.get('User-Agent') || null,
      device: req.get('User-Agent') || null,
    });

    AuditService.log({ action: AuditService.ACTIONS.USER_LOGIN, entityType: 'user', entityId: user.id, req });
    logger.info('User logged in', { userId: user.id, role: user.role });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: { id: user.id, email: user.email, role: user.role },
        token,
        accessToken: token,
        refreshToken: refresh.refreshToken,
        expiresIn: env.JWT_EXPIRY,
        refreshExpiresIn: env.REFRESH_TOKEN_EXPIRY,
      },
    });
  } catch (err) { next(err); }
};

// ─── POST /auth/refresh ──────────────────────────────────────────────────────
exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken is required' });
    }

    let rotation;
    try {
      rotation = await RefreshTokenService.rotateRefreshToken(refreshToken, redis, {
        ip: req.ip,
        userAgent: req.get('User-Agent') || null,
      });
    } catch (err) {
      if (err.code === 'REDIS_UNAVAILABLE') {
        return res.status(503).json({ success: false, message: 'Refresh service unavailable. Please try again later.' });
      }
      if (err.code === 'TOKEN_REUSE' && err.userId) {
        await revokeAllUserTokens(err.userId, db, redis);
        await RefreshTokenService.revokeAllRefreshTokensForUser(err.userId, redis);
        return res.status(401).json({ success: false, message: 'Refresh token reuse detected. All sessions revoked.' });
      }
      return res.status(401).json({ success: false, message: 'Invalid refresh token.' });
    }

    const userResult = await db.query(
      'SELECT id, email, role, is_active, password_changed_at FROM users WHERE id = $1',
      [rotation.userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
      await RefreshTokenService.revokeAllRefreshTokensForUser(rotation.userId, redis);
      return res.status(401).json({ success: false, message: 'Refresh token is no longer valid.' });
    }

    const user = userResult.rows[0];
    if (user.password_changed_at && rotation.createdAt) {
      const createdAt = new Date(rotation.createdAt).getTime();
      const changedAt = new Date(user.password_changed_at).getTime();
      if (createdAt < changedAt) {
        await revokeAllUserTokens(user.id, db, redis);
        await RefreshTokenService.revokeAllRefreshTokensForUser(user.id, redis);
        return res.status(401).json({ success: false, message: 'Refresh token invalid after password change. Please sign in again.' });
      }
    }

    const { token } = generateToken({ id: user.id, role: user.role });
    res.json({
      success: true,
      data: {
        token,
        accessToken: token,
        refreshToken: rotation.refreshToken,
        expiresIn: env.JWT_EXPIRY,
        refreshExpiresIn: env.REFRESH_TOKEN_EXPIRY,
      },
    });
  } catch (err) { next(err); }
};

// ─── POST /auth/logout ───────────────────────────────────────────────────────
exports.logout = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ success: false, message: 'refreshToken is required for logout' });
    }

    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const decoded = decodeToken(authHeader.slice(7));
      if (decoded?.jti) {
        await revokeToken(decoded.jti, decoded.sub || req.user?.id, db, redis);
      }
    }

    await RefreshTokenService.deleteRefreshToken(refreshToken, redis);
    AuditService.log({ action: AuditService.ACTIONS.USER_LOGOUT, entityType: 'user', entityId: req.user?.id || null, req });
    logger.info('User logged out', { userId: req.user?.id || null });
    res.json({ success: true, message: 'Logged out successfully. Refresh token deleted.' });
  } catch (err) { next(err); }
};

exports.listSessions = async (req, res, next) => {
  try {
    const sessions = await RefreshTokenService.getSessionsForUser(req.user.id, redis);
    res.json({ success: true, data: { sessions } });
  } catch (err) {
    if (err.code === 'REDIS_UNAVAILABLE') {
      return res.status(503).json({ success: false, message: 'Session service unavailable. Please try again later.' });
    }
    next(err);
  }
};

exports.revokeSession = async (req, res, next) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ success: false, message: 'sessionId is required' });
    }

    const deleted = await RefreshTokenService.deleteSession(req.user.id, sessionId, redis);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Session not found' });
    }

    AuditService.log({
      action: AuditService.ACTIONS.USER_SESSION_REVOKED,
      entityType: 'user',
      entityId: req.user.id,
      beforeData: { sessionId },
      req,
    });

    res.json({ success: true, message: 'Session revoked successfully' });
  } catch (err) {
    if (err.code === 'REDIS_UNAVAILABLE') {
      return res.status(503).json({ success: false, message: 'Session service unavailable. Please try again later.' });
    }
    next(err);
  }
};

exports.revokeAllSessions = async (req, res, next) => {
  try {
    await RefreshTokenService.revokeAllRefreshTokensForUser(req.user.id, redis);
    await revokeAllUserTokens(req.user.id, db, redis);

    AuditService.log({
      action: AuditService.ACTIONS.USER_SESSIONS_REVOKED,
      entityType: 'user',
      entityId: req.user.id,
      req,
    });

    res.json({ success: true, message: 'All sessions revoked successfully' });
  } catch (err) {
    if (err.code === 'REDIS_UNAVAILABLE') {
      return res.status(503).json({ success: false, message: 'Session service unavailable. Please try again later.' });
    }
    next(err);
  }
};

// ─── GET /auth/me ────────────────────────────────────────────────────────────
exports.getCurrentUser = async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, email, name, phone, role, created_at, updated_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: { user: result.rows[0] } });
  } catch (err) { next(err); }
};

// ─── POST /auth/forgot-password ──────────────────────────────────────────────
exports.forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') return res.status(400).json({ success: false, message: 'email is required' });

    const normalizedEmail = email.toLowerCase().trim();
    const userResult = await db.query(
      'SELECT id, email, name FROM users WHERE email = $1 AND is_active = true',
      [normalizedEmail]
    );

    if (userResult.rows.length === 0) {
      await bcrypt.hash('dummy-timing-equaliser', BCRYPT_ROUNDS);
      return res.status(200).json({ success: true, message: 'If an account exists with that email, you will receive a reset code shortly.' });
    }

    const user   = userResult.rows[0];
    const crypto = require('crypto');
    const rawOtp = String(crypto.randomInt(100000, 999999));
    const tokenHash = await bcrypt.hash(rawOtp, BCRYPT_ROUNDS);

    await db.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, attempts, created_at)
       VALUES ($1, $2, NOW() + INTERVAL '15 minutes', 0, NOW())
       ON CONFLICT (user_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, attempts = 0, created_at = NOW()`,
      [user.id, tokenHash]
    );

    const EmailService = require('../services/emailService');
    await EmailService.sendPasswordResetOTP(user, rawOtp);

    AuditService.log({ action: AuditService.ACTIONS.USER_PASSWORD_RESET, entityType: 'user', entityId: user.id, req });
    logger.info('Password reset OTP issued', { userId: user.id });
    return res.status(200).json({ success: true, message: 'If an account exists with that email, you will receive a reset code shortly.' });
  } catch (err) { next(err); }
};

// ─── POST /auth/reset-password ───────────────────────────────────────────────
exports.resetPassword = async (req, res, next) => {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) return res.status(400).json({ success: false, message: 'email, otp, and newPassword are required' });
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ success: false, message: 'OTP must be a 6-digit number' });
    if (newPassword.length < 8 || newPassword.length > MAX_PASSWORD_LEN) return res.status(400).json({ success: false, message: 'New password must be 8–72 characters' });

    const normalizedEmail = email.toLowerCase().trim();
    const result = await db.query(
      `SELECT u.id AS user_id, u.email, prt.token_hash, prt.expires_at, prt.attempts
       FROM users u JOIN password_reset_tokens prt ON prt.user_id = u.id
       WHERE u.email = $1 AND u.is_active = true AND prt.expires_at > NOW()`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      await bcrypt.compare('dummy', '$2a$12$dummy.hash.that.never.matches.padding.pad');
      return res.status(400).json({ success: false, message: 'Invalid or expired reset code. Please request a new one.' });
    }

    const row = result.rows[0];
    if (row.attempts >= 5) {
      await db.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);
      return res.status(400).json({ success: false, message: 'Too many incorrect attempts. Please request a new reset code.' });
    }

    const valid = await bcrypt.compare(otp, row.token_hash);
    if (!valid) {
      await db.query('UPDATE password_reset_tokens SET attempts = attempts + 1 WHERE user_id = $1', [row.user_id]);
      return res.status(400).json({ success: false, message: 'Incorrect reset code. Please check and try again.' });
    }

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.transaction(async (client) => {
      await client.query('UPDATE users SET password_hash = $1, updated_at = NOW(), password_changed_at = NOW() WHERE id = $2', [newHash, row.user_id]);
      await client.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [row.user_id]);
    });

    await revokeAllUserTokens(row.user_id, db, redis);
    await RefreshTokenService.revokeAllRefreshTokensForUser(row.user_id, redis);

    AuditService.log({ action: AuditService.ACTIONS.USER_PASSWORD_RESET, entityType: 'user', entityId: row.user_id, req });
    logger.info('Password reset completed', { userId: row.user_id });
    return res.status(200).json({ success: true, message: 'Password reset successful. Please log in with your new password.' });
  } catch (err) { next(err); }
};

// ─── PUT /auth/profile ───────────────────────────────────────────────────────
exports.updateProfile = async (req, res, next) => {
  try {
    const { name, phone } = req.body;
    const updates = []; const values = []; let idx = 1;
    if (name)  { updates.push(`name = $${idx++}`);  values.push(name.trim()); }
    if (phone) { updates.push(`phone = $${idx++}`); values.push(phone.trim()); }
    if (updates.length === 0) return res.status(400).json({ success: false, message: 'No fields to update' });
    updates.push('updated_at = NOW()');
    values.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, email, name, phone, role, updated_at`,
      values
    );
    res.json({ success: true, data: { user: result.rows[0] } });
  } catch (err) { next(err); }
};

// ─── POST /auth/change-password ──────────────────────────────────────────────
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ success: false, message: 'currentPassword and newPassword are required' });
    if (newPassword.length < 8 || newPassword.length > MAX_PASSWORD_LEN) return res.status(400).json({ success: false, message: 'New password must be 8–72 characters' });

    const userResult = await db.query('SELECT id, password_hash FROM users WHERE id = $1', [req.user.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW(), password_changed_at = NOW() WHERE id = $2', [newHash, req.user.id]);

    await revokeAllUserTokens(req.user.id, db, redis);
    await RefreshTokenService.revokeAllRefreshTokensForUser(req.user.id, redis);

    // Revoke the current session token
    const authHeader = req.headers.authorization;
    if (authHeader) {
      const decoded = decodeToken(authHeader.slice(7));
      if (decoded?.jti) await revokeToken(decoded.jti, req.user.id, db, redis);
    }

    AuditService.log({ action: AuditService.ACTIONS.USER_PASSWORD_CHANGED, entityType: 'user', entityId: req.user.id, req });
    logger.info('Password changed', { userId: req.user.id });
    res.json({ success: true, message: 'Password changed successfully. Please log in again with your new password.' });
  } catch (err) { next(err); }
};
