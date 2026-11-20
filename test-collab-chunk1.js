#!/usr/bin/env node

/**
 * Comprehensive Collaboration Protocol Verification - Part 1: Setup & Workspace Bootstrap
 */

const WebSocket = require('ws');
const { Y, applyUpdate, encodeStateAsUpdate } = require('yjs');
const crypto = require('crypto');

// Configuration
const CONFIG = {
  baseUrl: 'http://localhost:8787',
  wsUrl: 'ws://localhost:8787/ws',
  testUser: {
    email: `collab-test-${Date.now()}@example.com`,
    password: 'Test1234!',
    name: 'Collaboration Test'
  },
  workspaceName: `Test Workspace ${Date.now()}`,
  spaceName: `Public Space ${Date.now()}`,
};

// State tracking
let accessToken = null;
let userId = null;
let workspaceId = null;
let publicSpaceId = null;
let pageId = null;

const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bright: '\x1b[1m',
  fgRed: '\x1b[31m',
  fgGreen: '\x1b[32m',
  fgYellow: '\x1b[33m',
  fgBlue: '\x1b[34m',
};

function log(phase, msg) {
  const time = new Date().toISOString().substr(11, 8);
  console.log(`[${time}] ${colors.bright}${phase}${colors.reset} ${msg}`);
}

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function generateClientId() { return crypto.randomBytes(16).toString('hex'); }

// Phase 2: Workspace Bootstrap Flow
async function testPhase2_WorkspaceBootstrap() {
  log('PHASE 2', 'Testing workspace bootstrap flow...');

  // Register user
  try {
    const res = await fetch(`${CONFIG.baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CONFIG.testUser)
    });
    
    if (res.status === 409) {
      log('PHASE 2', 'User exists, proceeding to login...');
      // Delete or use existing - try login anyway below
    } else if (!res.ok) {
      const err = await res.json();
      throw new Error(`Registration failed: ${JSON.stringify(err)}`);
    }
    
    log('PHASE 2', `User registered: ${CONFIG.testUser.email}`);

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 2 ERROR:', err.message, colors.reset);
    return false;
  }

  // Login and get token
  const loginRes = await fetch(`${CONFIG.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: CONFIG.testUser.email,
      password: CONFIG.testUser.password
    })
  });

  if (!loginRes.ok) {
    const err = await loginRes.json();
    throw new Error(`Login failed: ${JSON.stringify(err)}`);
  }

  const tokenData = await loginRes.json();
  accessToken = tokenData.access_token;
  userId = tokenData.user.id;
  
  log('PHASE 2', `Obtained access token (expires: ${tokenData.expires_at})`);
  log('PHASE 2', `User ID: ${userId}`);

  // Get workspaces or create new one
  const wsRes = await fetch(`${CONFIG.baseUrl}/api/workspaces`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!wsRes.ok) throw new Error(`Workspaces request failed: ${wsRes.status} ${await wsRes.text()}`);
  const workspaces = await wsRes.json();
  
  log('PHASE 2', `Found ${workspaces.length} workspace(s)`);
  
  // Create workspace if none exists
  if (workspaces.length === 0) {
    const createWs = await fetch(`${CONFIG.baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ name: CONFIG.workspaceName })
    });

    if (!createWs.ok) throw new Error('Workspace creation failed');
    const data = await createWs.json();
    workspaceId = data.id;
    log('PHASE 2', `Created workspace: ${data.name} (ID: ${workspaceId})`);
    
  } else {
    // Use first workspace
    const ws = workspaces[0];
    workspaceId = ws.id;
    log('PHASE 2', `Using existing workspace: ${ws.name} (ID: ${workspaceId})`);
  }

  // Get workspace outline/bootstrapping data
  const outlineRes = await fetch(`${CONFIG.baseUrl}/api/workspaces/${workspaceId}/outline`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!outlineRes.ok) throw new Error(`Outline request failed: ${outlineRes.status} ${await outlineRes.text()}`);
  const outline = await outlineRes.json();
  
  log('PHASE 2', `Workspace outline retrieved. Name: ${outline.name}, Spaces: ${JSON.stringify(outline.spaces || []).length}`);
  
  if (!outline.id || !outline.name) {
    throw new Error('Outline missing required fields (id/name)');
  }

  return true;
}

module.exports = { 
  CONFIG, accessToken, userId, workspaceId, publicSpaceId, pageId, colors, log, sleep, generateClientId,
  testPhase2_WorkspaceBootstrap 
};
