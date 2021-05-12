import fetch from 'node-fetch';
import * as electron from 'electron';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as stream from 'stream';
import * as http from 'http';
import * as crypto from 'crypto';

type TBundleName = 'renderer.js' | 'vendors~renderer.js';

interface IManifest {
  'renderer.js': string;
  'vendors~renderer.js': string;
  checksums?: {
    [bundle: string]: string;
  };
}

module.exports = async (basePath: string) => {
  const cdnBase = `https://slobs-cdn.streamlabs.com/${process.env.SLOBS_VERSION}${
    process.platform === 'darwin' ? '-mac' : ''
  }/bundles/`;
  const localBase = `file://${basePath}/bundles/`;
  const bundlesBaseDirectory = path.join(electron.app.getPath('userData'), 'bundles');
  const bundleDirectory = path.join(bundlesBaseDirectory, process.env.SLOBS_VERSION!);

  let updaterWindow: electron.BrowserWindow;
  let updaterWindowSuccessfulClose = false;

  function spawnUpdaterWindow() {
    updaterWindow = new electron.BrowserWindow({
      width: 400,
      height: 180,
      frame: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      webPreferences: { nodeIntegration: true },
    });

    updaterWindow.on('ready-to-show', () => {
      updaterWindow.show();
    });

    updaterWindow.on('close', () => {
      if (!updaterWindowSuccessfulClose) electron.app.quit();
    });

    updaterWindow.loadURL(`file://${basePath}/updater/index.html`);
  }

  function closeUpdaterWindow() {
    updaterWindowSuccessfulClose = true;
    if (updaterWindow) {
      // Closing the only window would normally quit the app, so ensure it doesn't.
      electron.app.once('will-quit', e => e.preventDefault());
      updaterWindow.close();
    }
  }

  function downloadFile(srcUrl: string, dstPath: string): Promise<void> {
    const tmpPath = `${dstPath}.tmp`;

    return new Promise<void>((resolve, reject) => {
      fetch(srcUrl)
        .then(response => {
          if (response.ok) return response;

          console.log(`Got ${response.status} response from ${srcUrl}`);
          return Promise.reject(response);
        })
        .then(({ body }) => {
          const fileStream = fs.createWriteStream(tmpPath);

          stream.pipeline(body, fileStream, e => {
            if (e) {
              console.log(`Error downloading ${srcUrl}`, e);
              reject(e);
            } else {
              fs.rename(tmpPath, dstPath, e => {
                if (e) {
                  reject(e);
                  return;
                }

                console.log(`Successfully downloaded ${srcUrl}`);
                resolve();
              });
            }
          });
        })
        .catch(e => reject(e));
    });
  }

  function getChecksum(filePath: string) {
    return new Promise<string>((resolve, reject) => {
      const file = fs.createReadStream(filePath);
      const hash = crypto.createHash('md5');

      stream.pipeline(file, hash, e => {
        if (e) {
          console.log(`Error reading checksum of ${filePath}`, e);
          reject(e);
        } else {
          try {
            const checksum = hash.read().toString('hex');
            console.log(`Got checksum: ${filePath} => ${checksum}`);
            resolve(checksum);
          } catch (e: unknown) {
            console.log(`Error reading checksum of ${filePath}`, e);
            reject(e);
          }
        }
      });
    });
  }

  async function validateFile(
    bundle: string,
    filePath: string,
    manifest: IManifest,
  ): Promise<boolean> {
    if (!manifest.checksums || !manifest.checksums[bundle]) {
      console.log(`Checksums not found in manifest, assuming ${bundle} is valid`);
      return true;
    }

    try {
      const expectedChecksum = manifest.checksums[bundle];
      const actualChecksum = await getChecksum(filePath);

      if (expectedChecksum === actualChecksum) {
        console.log(`${bundle} passed checksum validation`);
        return true;
      } else {
        console.log(
          `Got checksum mismatch on ${bundle}: ${expectedChecksum} =/= ${actualChecksum}`,
        );

        // Attempt to remove the file so it will re-download next time
        fs.unlinkSync(filePath);

        return false;
      }
    } catch (e: unknown) {
      console.log(`Error determining checksum for ${bundle}`);
      return false;
    }
  }

  /**
   * This ensures that if there isn't a directory for this specific container version,
   * we empty the bundles directory (to preserve HD space over time) and create a new
   * directory for this specific version.
   */
  async function ensureBundlesDirectory() {
    if (!fs.existsSync(bundleDirectory)) {
      fs.emptyDirSync(bundlesBaseDirectory);
      fs.mkdirSync(bundleDirectory);
    }
  }

  async function getBundleFilePath(bundle: string, manifest: IManifest): Promise<string> {
    console.log(`Looking for bundle: ${bundle}`);

    // Check for bundle in this app package
    const localPath = path.join(basePath, 'bundles', bundle);
    if (fs.existsSync(localPath)) {
      console.log(`Found local bundle ${bundle}`);
      return localPath;
    }

    // Fall back to checking the download directory
    const downloadPath = path.join(bundleDirectory, bundle);
    if (fs.existsSync(downloadPath)) {
      console.log(`Found existing downloaded bundle ${bundle}`);

      if (await validateFile(bundle, downloadPath, manifest)) {
        return downloadPath;
      }
    }

    // Finally check the server
    const serverPath = `${cdnBase}${bundle}`;
    console.log(`Attempting to download bundle ${bundle}`);
    ensureBundlesDirectory();
    await downloadFile(serverPath, downloadPath);

    if (!(await validateFile(bundle, downloadPath, manifest))) {
      return Promise.reject('File failed to validate');
    }

    return downloadPath;
  }

  let useLocalBundles = false;

  if (process.argv.includes('--local-bundles')) {
    useLocalBundles = true;
  }

  if (process.env.NODE_ENV !== 'production') {
    useLocalBundles = true;
  }

  const localManifest: IManifest = require(path.join(`${basePath}/bundles/manifest.json`));

  console.log('Local bundle info:', localManifest);

  // Check if bundle updates are available
  // TODO: Cache the latest manifest for offline use?
  let serverManifest: IManifest | undefined;

  if (!useLocalBundles) {
    try {
      const remoteManifestName = process.argv.includes('--bundle-qa')
        ? 'manifest-qa.json'
        : 'manifest.json';
      const response = await fetch(`${cdnBase}${remoteManifestName}`);

      if (response.status / 100 >= 4) {
        console.log('Bundle manifest not available, using local bundles');
        useLocalBundles = true;
      } else {
        const parsed = await response.json();
        console.log('Latest bundle info:', parsed);

        serverManifest = parsed;
      }
    } catch (e: unknown) {
      console.log('Bundle manifest fetch error', e);
      useLocalBundles = true;
    }
  }

  const bundlePathsMap: { [bundle: string]: string } = {};

  if (!useLocalBundles && serverManifest) {
    const bundles = ['renderer.js', 'vendors~renderer.js'] as const;
    const promises = bundles.map(bundleName => {
      return getBundleFilePath(serverManifest![bundleName], serverManifest!).then(bundlePath => {
        bundlePathsMap[bundleName] = bundlePath;
      });
    });

    let timeout: NodeJS.Timeout | null = null;

    try {
      // Either all bundles need to successfully download, or we have to revert to local.
      // If this takes more than 10 seconds, we will spawn a window to let the user know
      // we are working on updates.
      timeout = setTimeout(() => {
        spawnUpdaterWindow();
      }, 10 * 1000);

      await Promise.all(promises);

      clearTimeout(timeout);
      closeUpdaterWindow();
    } catch (e: unknown) {
      if (timeout) clearTimeout(timeout);
      closeUpdaterWindow();
      console.log('Failed to download 1 or more bundles', e);
      useLocalBundles = true;
    }
  }

  // Used for sending accurate stack traces to sentry
  electron.ipcMain.on('getBundleNames', (e: Electron.Event, bundles: TBundleName[]) => {
    const bundleNames: { [bundle: string]: string } = {};

    bundles.forEach(bundle => {
      if (!useLocalBundles && serverManifest && serverManifest[bundle]) {
        bundleNames[bundle] = serverManifest[bundle];
      } else {
        bundleNames[bundle] = localManifest[bundle];
      }
    });

    // @ts-ignore Electron types are wrong here
    e.returnValue = bundleNames;
  });

  electron.session.defaultSession?.webRequest.onBeforeRequest(
    { urls: ['https://slobs-cdn.streamlabs.com/bundles/*.js'] },
    (request, cb) => {
      const bundleName = request.url.split('/')[4] as TBundleName;

      if (!useLocalBundles && bundlePathsMap[bundleName]) {
        // Work around an extreme edge case where people have # in home directory path
        const sanitizedBundleUrl = `file://${bundlePathsMap[bundleName]}`.replace('#', '%23');

        cb({ redirectURL: sanitizedBundleUrl });
        return;
      }

      console.log(`Using local bundle for ${bundleName}`);
      cb({ redirectURL: `${localBase}${localManifest[bundleName]}` });
    },
  );

  // Use a local web server to serve source maps in development.
  // This is needed because chromium no longer uses the redirect
  // URL when looking for source maps.
  if (!['production', 'test'].includes(process.env.NODE_ENV ?? '')) {
    const handler = require('serve-handler');

    const server = http.createServer((request, response) => {
      handler(request, response, {
        public: path.resolve(__dirname, '..', '..', 'bundles'),
        headers: [
          {
            source: '**',
            headers: [
              {
                key: 'Cache-Control',
                value: 'no-cache, no-store, must-revalidate',
              },
            ],
          },
        ],
      });
    });

    server.listen(9000);
  }

  electron.ipcMain.on('startupError', (e, msg) => {
    console.log('Received startup error from worker window', msg);

    // Unregister the main process from the crash handler
    try {
      const crashHandler = require('crash-handler');
      crashHandler.unregisterProcess(process.pid);
    } catch (e: unknown) {
      console.log('Error unregistering main process from crash handler');
    }

    electron.app.on('window-all-closed', (e: Electron.Event) => {
      e.preventDefault();

      // Wait a second for files to no longer be in use
      setTimeout(() => {
        console.log('Attempting to empty bundles directory');
        try {
          // Try clearing the bundles directory in case it got corrupted
          if (fs.existsSync(bundlesBaseDirectory)) {
            fs.emptyDirSync(bundlesBaseDirectory);
          }
        } catch (e: unknown) {
          console.log('Error clearing bundle directory', e);
        }

        console.log('The app will now shut down');
        electron.app.exit();
      }, 1000);
    });

    // Force close all windows
    electron.BrowserWindow.getAllWindows().forEach(w => {
      if (!w.isDestroyed()) {
        console.log('Force closing window', w.id);
        w.destroy();
      }
    });

    electron.dialog.showErrorBox(
      'Streamlabs OBS',
      'Streamlabs OBS failed to start. Please try launching Streamlabs OBS again. If this issue persists, please visit support.streamlabs.com for help.',
    );
  });
};
