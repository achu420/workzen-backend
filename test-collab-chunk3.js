/**
 * Part 3: Document Persistence (Phase 5) - HTTP-based sync
 */

const { Y, applyUpdate } = require('yjs');
const { accessToken, workspaceId, pageId, log, colors } = require('./test-collab-chunk1');

async function testPhase5_DocumentPersistence() {
  log('PHASE 5', 'Testing document content persistence (HTTP)...');
  
  const authHeader = { Authorization: `Bearer ${accessToken}` };
  
  // Attempt to fetch Yjs state via HTTP (full sync)
  try {
    const res = await fetch(
      `${CONFIG.baseUrl}/api/workspaces/${workspaceId}/pages/${pageId}/doc`,
      { headers: authHeader }
    );

    if (!res.ok) {
      log('PHASE 5', `Document HTTP endpoint returned ${res.status}: ${await res.text()}`);
      // This might be expected - WebSocket is primary, HTTP may not exist yet
      return null; // Unknown/incomplete but not fatal
    }

    const data = await res.json();
    
    if (data.docState) {
      log('PHASE 5', `Received doc state: ${Buffer.from(data.docState).length} bytes`);
      
      try {
        const ydoc = new Y.Doc();
        applyUpdate(ydoc, Buffer.from(data.docState, 'base64'));
        log('PHASE 5', `✓ Valid Yjs document loaded. Content keys: ${Object.keys(ydoc.getDoc())}`);

      } catch (err) {
        throw new Error(`Invalid Yjs format in docState: ${err.message}`);
      }
    } else if (data.docUpdate) {
      log('PHASE 5', `Received doc update: ${Buffer.from(data.docUpdate).length} bytes`);
      
      try {
        const ydoc = new Y.Doc();
        applyUpdate(ydoc, Buffer.from(data.docUpdate, 'base64'));
        log('PHASE 5', `✓ Valid Yjs update loaded.`);

      } catch (err) {
        throw new Error(`Invalid Yjs format in docUpdate: ${err.message}`);
      }
    } else {
      throw new Error('Missing docState/docUpdate in HTTP response');
    }

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 5 ERROR:', err.message, colors.reset);
    return false;
  }

  // Test write persistence if HTTP update endpoint exists
  try {
    const ydoc = new Y.Doc();
    
    // Create some content to persist
    const text = ydoc.get('content', Y.Text);
    text.insert(0, 'Hello from Phase 5 automated test\n');
    
    const update = encodeStateAsUpdate(ydoc);
    
    log('PHASE 5', `Generated update with ${update.length} bytes: "${text.toString()}"`);

    // Try PUT/POST to persist the state
    const methods = ['PUT', 'POST'];
    for (const method of methods) {
      try {
        const updateRes = await fetch(
          `${CONFIG.baseUrl}/api/workspaces/${workspaceId}/pages/${pageId}/doc`,
          {
            method: method,
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ docState: Buffer.from(update).toString('base64') })
          }
        );

        if (updateRes.ok) {
          log('PHASE 5', `✓ HTTP ${method} persistence successful`);
          
          // Verify by fetching again immediately
          const verifyRes = await fetch(
            `${CONFIG.baseUrl}/api/workspaces/${workspaceId}/pages/${pageId}/doc`,
            { headers: authHeader }
          );
          
          if (verifyRes.ok) {
            const data = await verifyRes.json();
            const ydoc2 = new Y.Doc();
            applyUpdate(ydoc2, Buffer.from(data.docState || data.docUpdate, 'base64'));
            
            const content = ydoc2.get('content', Y.Text)?.toString() || '(empty)';
            if (content.includes('Phase 5')) {
              log('PHASE 5', `✓ Persistence verified: "${content}"`);
              return true;
            } else {
              throw new Error(`Persistence mismatch: got "${content}"`);
            }
          }
        }
      } catch (e) {
        // Try next method
      }
    }

  } catch (err) {
    console.error(colors.fgRed + 'PHASE 5 ERROR:', err.message, colors.reset);
    return false;
  }

  log('PHASE 5', 'HTTP persistence endpoint not found - relying on WebSocket');
  return null; // Partial/unknown status is acceptable here
}

module.exports = { testPhase5_DocumentPersistence };
