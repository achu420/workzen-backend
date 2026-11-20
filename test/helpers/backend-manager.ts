import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

interface BackendInstance {
  port: number;
  process: any;
  dataFile: string;
}

/**
 * Manages isolated backend instances for testing.
 */
export class BackendManager {
  private static nextPort = 45300;

  static async start(): Promise<BackendInstance> {
    const port = this.nextPort++;
    const dataFile = path.join('/tmp', `appflowy-test-${Date.now()}.json`);
    
    fs.writeFileSync(dataFile, '{}');
    console.log(`[Backend] Starting on port ${port}, data: ${dataFile}`);

    const process = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: port.toString(), DATA_FILE: dataFile },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => { process.kill(); reject(new Error('Timeout')); }, 30000);

      process.stdout.on('data', (d: Buffer) => {
        const out = d.toString();
        console.log(`[Backend] ${out}`);
        if ((out.includes('Server is running') || out.includes('Listening on port')) && !ready) {
          clearTimeout(timeout); ready = true; resolve({ port, process, dataFile });
        }
      });

      process.stderr.on('data', (d: Buffer) => console.error(`[Backend] ${d}`));
      process.on('error', reject);
    });
  }
  static async createUser(port: number, password = 'password123'): Promise<{ userId: string; accessToken: string }> {
    const email = `test${Date.now()}@example.com`;
    
    const resp = await fetch(`http://localhost:${port}/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', username: email, password })
    });

    if (!resp.ok) throw new Error('User creation failed');
    const data = await resp.json();
    
    // Get user ID via verify endpoint
    const profileResp = await fetch(`http://localhost:${port}/api/user/verify/${data.access_token}`);
    const profileData = await profileResp.json();
    
    return { userId: profileData.data.user_id, accessToken: data.access_token };
  }

  static async createSpace(port: number, token: string, workspaceId: string): Promise<{ viewId: string }> {
    const resp = await fetch(`http://localhost:${port}/api/workspace/${workspaceId}/spaces`, {
      method: 'POST', headers: { 
        'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` 
      },
      body: JSON.stringify({ name: "Public", icon: "folder", permissions: [{id:"owner"}] })
    });

    if (!resp.ok) throw new Error('Space creation failed');
    const data = await resp.json();
    return { viewId: data.data.view_id };
  }

  static async createDocument(port: number, token: string, workspaceId: string): Promise<{ viewId: string }> {
    const resp = await fetch(`http://localhost:${port}/api/workspace/${workspaceId}/v2/page-view/document/default`, {
      method: 'POST', headers: { 
        'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` 
      },
      body: JSON.stringify({})
    });

    if (!resp.ok) throw new Error('Document creation failed');
    const data = await resp.json();
    return { viewId: data.data.view_id };
  }

  static getStorageState(dataFile: string): any {
    try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { return {}; }
  }

  static verifyPersistence(dataFile: string): boolean {
    const state = this.getStorageState(dataFile);
    return (state.pages && Object.keys(state.pages).length > 0) || false;
  }

  // Task 69 fix: this method was previously declared AFTER the class's
  // closing brace and `export default` statement -- a `static` modifier
  // used at module top-level is invalid JS/TS syntax, so this entire file
  // could not be parsed/loaded by any consumer (BaseScreen.cleanup() calls
  // BackendManager.stop(), which could therefore never have run). Moved
  // inside the class body where it belongs.
  static stop(instance: BackendInstance): void {
    console.log(`[Backend] Stopping port ${instance.port}`);
    try {
      instance.process.kill();
    } catch {
      // already exited
    }
    setTimeout(() => {
      try {
        fs.unlinkSync(instance.dataFile);
      } catch {
        // already removed
      }
    }, 2000);
  }
}

export default BackendManager;