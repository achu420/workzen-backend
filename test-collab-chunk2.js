/**
 * Part 2: Space Operations and Page Creation (Phases 3 & 4)
 */

const { testPhase2_WorkspaceBootstrap, accessToken, workspaceId, log, colors } = require('./test-collab-chunk1');

// Phase 3: Space/Workspace Operations  
async function testPhase3_SpaceOperations() {
  log('PHASE 3', 'Testing space operations...');
  
  const authHeader = { Authorization: `Bearer ${accessToken}` };

  // List spaces
  try {
    const res = await fetch(`${CONFIG.baseUrl}/api/workspaces/${workspaceId}/spaces`, {
      headers: authHeader
    });

    if (!res.ok) throw new Error(`Spaces list failed: ${res.status} ${await res.text()}`);
    
    const spaces = await res.json();
    log('PHASE 3', `Found ${spaces.length} space(s)`);
    
    // Create public space
    const createRes = await fetch(`${CONFIG.baseUrl}/api/workspaces/${workspaceId}/spaces`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        name: CONFIG.spaceName,
        is_public: true 
      })
    });

    if (!createRes.ok) throw new Error(`Space creation failed: ${await createRes.text()}`);
    
    const space = await createRes.json();
    publicSpaceId = space.id;
    
    log('PHASE 3', `Created public space: ${space.name} (ID: ${publicSpaceId})`);

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 3 ERROR:', err.message, colors.reset);
    return false;
  }

  // Select/activate space if needed
  try {
    const res = await fetch(`${CONFIG.baseUrl}/api/workspaces/${workspaceId}/spaces/${publicSpaceId}`, {
      method: 'PUT',
      headers: authHeader
    });
    
    log('PHASE 3', `Space selection response: ${res.status}`);

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 3 ERROR:', err.message, colors.reset);
    return false;
  }

  return true;
}

// Phase 4: Page Creation and Retrieval
async function testPhase4_PageOperations() {
  log('PHASE 4', 'Testing page operations...');
  
  const authHeader = { Authorization: `Bearer ${accessToken}` };
  
  // Create page (document type)
  try {
    const res = await fetch(`${CONFIG.baseUrl}/api/workspaces/${workspaceId}/pages`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        name: `Test Page ${Date.now()}`,
        space_id: publicSpaceId,
        type: 'document' // or just omit to use default
      })
    });

    if (!res.ok) throw new Error(`Page creation failed: ${await res.text()}`);
    
    const page = await res.json();
    pageId = page.id;
    
    log('PHASE 4', `Created page: ${page.name} (ID: ${pageId})`);

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 4 ERROR:', err.message, colors.reset);
    return false;
  }

  // Retrieve page details to verify persistence
  try {
    const res = await fetch(`${CONFIG.baseUrl}/api/workspaces/${workspaceId}/pages/${pageId}`, {
      headers: authHeader
    });

    if (!res.ok) throw new Error(`Page retrieval failed: ${await res.text()}`);
    
    const page = await res.json();
    log('PHASE 4', `Retrieved page: ID=${page.id}, Name=${page.name}, Space=${page.space_id || 'null'}`);

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 4 ERROR:', err.message, colors.reset);
    return false;
  }

  return true;
}

module.exports = { testPhase3_SpaceOperations, testPhase4_PageOperations };
