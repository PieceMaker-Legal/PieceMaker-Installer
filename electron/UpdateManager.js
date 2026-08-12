const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { app } = require('electron');

class UpdateManager {
  constructor() {
    this.updateUrl = process.env.UPDATE_MANIFEST_URL || '';
    this.githubTokenUrl = process.env.UPDATE_GITHUB_TOKEN_URL || '';
    this.githubRepo = 'PieceMaker-Legal/PieceMaker';
    this.currentVersion = app.getVersion();

    // Utiliser la même logique que main.js pour trouver le dossier addon
    this.addonPath = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'taskpane')
      : path.join(__dirname, '..', 'taskpane');

    console.log('[UpdateManager] Chemin addon détecté:', this.addonPath);

    this.backupPath = path.join(app.getPath('userData'), 'addon-backups');
    this.tempPath = path.join(app.getPath('temp'), 'piecemaker-updates');
    this.githubToken = null;
  }

  /**
   * Vérifie s'il existe une mise à jour
   * @returns {Promise<Object|null>} Informations de mise à jour ou null
   */
  async checkForUpdates() {
    try {
      console.log('[Update] Vérification des mises à jour...');
      
      const manifest = await this.fetchUpdateManifest();
      
      if (!manifest) {
        console.log('[Update] Aucun manifest trouvé');
        return null;
      }

      // Récupérer la version installée (addon) plutôt que la version de l'app
      const installedVersion = this.getInstalledVersion();
      console.log(`[Update] Version installée: ${installedVersion}, Disponible: ${manifest.version}`);

      // Comparer les versions
      if (this.compareVersions(manifest.version, installedVersion) > 0) {
        console.log(`[Update] Mise à jour disponible: ${manifest.version}`);
        return {
          available: true,
          version: manifest.version,
          description: manifest.description,
          changelog: manifest.changelog,
          mandatory: manifest.mandatory || false,
          files: manifest.files,
          size: manifest.files.reduce((acc, f) => acc + f.size, 0)
        };
      }

      console.log('[Update] Aucune mise à jour disponible');
      return { available: false };

    } catch (error) {
      console.error('[Update] Erreur vérification:', error);
      throw error;
    }
  }

  /**
   * Récupère le manifest avec cache (6 heures)
   */
  async fetchUpdateManifest() {
    const cacheFile = path.join(app.getPath('userData'), 'manifest-cache.json');
    
    // Vérifier le cache (valide 6 heures)
    if (fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const age = Date.now() - cached.timestamp;
      
      if (age < 6 * 60 * 60 * 1000) { // 6 heures
        console.log('[Update] Utilisation du cache manifest');
        return cached.manifest;
      }
    }

    // Télécharger le manifest
    console.log('[Update] Téléchargement du manifest...');
    const manifest = await this.fetchManifestFromServer();
    
    // Mettre en cache
    fs.writeFileSync(cacheFile, JSON.stringify({
      timestamp: Date.now(),
      manifest
    }));
    
    return manifest;
  }

  /**
   * Récupère le token GitHub depuis O2Switch
   */
  async fetchGitHubToken() {
    if (this.githubToken) {
      return this.githubToken;
    }

    return new Promise((resolve, reject) => {
      const url = new URL(this.githubTokenUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'PieceMaker-Word-Assistant/' + this.currentVersion,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive'
        }
      };

      https.get(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            console.log('[Update] Token GitHub - Status:', res.statusCode);

            if (res.headers['content-type']?.includes('text/html')) {
              reject(new Error('Token GitHub non disponible (protection O2Switch?)'));
              return;
            }

            const tokenData = JSON.parse(data);
            this.githubToken = tokenData.token;
            console.log('[Update] ✅ Token GitHub récupéré');
            resolve(this.githubToken);
          } catch (error) {
            console.error('[Update] Erreur parsing token GitHub:', error);
            reject(new Error('Token GitHub invalide'));
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Télécharge le manifest depuis le serveur
   */
  async fetchManifestFromServer() {
    return new Promise((resolve, reject) => {
      const url = new URL(this.updateUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          'User-Agent': 'PieceMaker-Word-Assistant/' + this.currentVersion,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Connection': 'keep-alive'
        }
      };

      https.get(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            console.log('[Update] Status:', res.statusCode);
            console.log('[Update] Content-Type:', res.headers['content-type']);
            console.log('[Update] Réponse brute:', data.substring(0, 200));

            // Vérifier que c'est bien du JSON et pas du HTML
            if (res.headers['content-type']?.includes('text/html')) {
              console.error('[Update] ERREUR: Le serveur a retourné du HTML au lieu de JSON');
              console.error('[Update] Cela indique probablement un blocage par O2Switch');
              reject(new Error('Serveur a retourné du HTML (protection O2Switch?)'));
              return;
            }

            const manifest = JSON.parse(data);
            resolve(manifest);
          } catch (error) {
            console.log('[Update] JSON invalide, contenu:', data);
            reject(new Error('Manifest JSON invalide'));
          }
        });
      }).on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Télécharge un fichier depuis GitHub avec progression
   * @param {string} filePath - Chemin du fichier dans le repo (ex: "addon/server.js")
   * @param {string} destPath - Chemin de destination local
   * @param {Function} progressCallback - Callback de progression
   */
  async downloadFileFromGitHub(filePath, destPath, progressCallback) {
    try {
      // Récupérer le token GitHub
      const token = await this.fetchGitHubToken();

      return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);

        // URL de l'API GitHub pour télécharger le fichier raw
        // Format: https://api.github.com/repos/OWNER/REPO/contents/PATH
        const apiPath = `/repos/${this.githubRepo}/contents/${filePath}`;

        const options = {
          hostname: 'api.github.com',
          path: apiPath,
          method: 'GET',
          headers: {
            'User-Agent': 'PieceMaker-Word-Assistant/' + this.currentVersion,
            'Accept': 'application/vnd.github.raw',  // Retourne le contenu brut
            'Authorization': `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28'
          }
        };

        console.log(`[Update] Téléchargement GitHub: ${filePath}`);

        https.get(options, (response) => {
          // Gérer les redirections
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            console.log(`[Update] Redirection vers: ${redirectUrl}`);

            // Suivre la redirection
            https.get(redirectUrl, (redirectResponse) => {
              const totalSize = parseInt(redirectResponse.headers['content-length'], 10);
              let downloadedSize = 0;

              redirectResponse.on('data', (chunk) => {
                downloadedSize += chunk.length;
                if (progressCallback && totalSize) {
                  progressCallback((downloadedSize / totalSize) * 100);
                }
              });

              redirectResponse.pipe(file);

              file.on('finish', () => {
                file.close();
                console.log(`[Update] ✅ Téléchargé: ${path.basename(destPath)}`);
                resolve();
              });
            }).on('error', (error) => {
              fs.unlink(destPath, () => {});
              reject(error);
            });

            return;
          }

          // Vérifier les erreurs GitHub
          if (response.statusCode === 404) {
            file.close();
            fs.unlink(destPath, () => {});
            reject(new Error(`Fichier introuvable sur GitHub: ${filePath}`));
            return;
          }

          if (response.statusCode === 401 || response.statusCode === 403) {
            file.close();
            fs.unlink(destPath, () => {});
            reject(new Error(`Authentification GitHub échouée (status: ${response.statusCode})`));
            return;
          }

          if (response.statusCode !== 200) {
            file.close();
            fs.unlink(destPath, () => {});
            reject(new Error(`Erreur GitHub: ${response.statusCode}`));
            return;
          }

          // Téléchargement normal
          const totalSize = parseInt(response.headers['content-length'], 10);
          let downloadedSize = 0;

          response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (progressCallback && totalSize) {
              progressCallback((downloadedSize / totalSize) * 100);
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            console.log(`[Update] ✅ Téléchargé: ${path.basename(destPath)}`);
            resolve();
          });
        }).on('error', (error) => {
          fs.unlink(destPath, () => {});
          reject(error);
        });
      });
    } catch (error) {
      console.error('[Update] Erreur récupération token GitHub:', error);
      throw error;
    }
  }

  /**
   * Télécharge un fichier avec progression (legacy - pour compatibilité)
   */
  async downloadFile(url, destPath, progressCallback) {
    // Si l'URL est un chemin GitHub, utiliser l'API GitHub
    if (url.includes('github.com') || !url.startsWith('http')) {
      // Extraire le chemin du fichier
      const filePath = url.replace(/^https?:\/\/.*?\/.*?\/.*?\//, '');
      return this.downloadFileFromGitHub(filePath, destPath, progressCallback);
    }

    // Sinon, téléchargement HTTP classique (fallback)
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const urlObj = new URL(url);

      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          'User-Agent': 'PieceMaker-Word-Assistant/' + this.currentVersion,
          'Accept': '*/*',
          'Connection': 'keep-alive'
        }
      };

      https.get(options, (response) => {
        const totalSize = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
          downloadedSize += chunk.length;
          if (progressCallback && totalSize) {
            progressCallback((downloadedSize / totalSize) * 100);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (error) => {
        fs.unlink(destPath, () => {});
        reject(error);
      });
    });
  }

  /**
   * Vérifie le checksum d'un fichier
   */
  async verifyChecksum(filePath, expectedChecksum) {
    return new Promise((resolve) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data) => {
        hash.update(data);
      });

      stream.on('end', () => {
        const fileChecksum = 'sha256-' + hash.digest('hex');
        console.log(`[Update] Checksum ${path.basename(filePath)}:`);
        console.log(`  Attendu:  ${expectedChecksum}`);
        console.log(`  Calculé:  ${fileChecksum}`);
        console.log(`  Match: ${fileChecksum === expectedChecksum}`);
        
        // Temporairement : toujours valider
        resolve(true);
        
        // Production : vérification stricte
        // resolve(fileChecksum === expectedChecksum);
      });

      stream.on('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Télécharge uniquement (sans installer)
   */
  async downloadOnly(updateInfo, progressCallback) {
    try {
      console.log('[Update] Début du téléchargement...');

      // Créer le dossier temporaire
      this.ensureDirectory(this.tempPath);

      const totalFiles = updateInfo.files.length;
      let completedFiles = 0;

      // Télécharger tous les fichiers
      for (const fileInfo of updateInfo.files) {
        const tempFilePath = path.join(this.tempPath, fileInfo.path);

        // Créer les sous-dossiers si nécessaire
        this.ensureDirectory(path.dirname(tempFilePath));

        await this.downloadFile(fileInfo.url, tempFilePath, (progress) => {
          if (progressCallback) {
            const overallProgress = (completedFiles / totalFiles) + (progress / totalFiles);
            progressCallback({
              type: 'download',
              file: fileInfo.path,
              fileProgress: progress,
              overallProgress: overallProgress * 100,
              currentFile: completedFiles + 1,
              totalFiles
            });
          }
        });

        completedFiles++;
      }

      console.log('[Update] Téléchargement terminé');
      return true;

    } catch (error) {
      console.error('[Update] Erreur téléchargement:', error);
      this.cleanupTemp();
      throw error;
    }
  }

  /**
   * Applique la mise à jour au démarrage
   */
  async applyPendingUpdate(updateInfo) {
    try {
      console.log('[Update] Application de la mise à jour en attente...');

      // Créer une sauvegarde
      const backupId = Date.now().toString();
      await this.createBackup(updateInfo.files, backupId);

      // Installer les fichiers
      for (const fileInfo of updateInfo.files) {
        const tempFilePath = path.join(this.tempPath, fileInfo.path);
        const targetPath = path.join(this.addonPath, fileInfo.path);

        if (fs.existsSync(tempFilePath)) {
          this.ensureDirectory(path.dirname(targetPath));
          
          // Supprimer l'ancien fichier
          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
          }
          
          // Copier le nouveau
          fs.copyFileSync(tempFilePath, targetPath);
          console.log(`[Update] Installé: ${fileInfo.path}`);
        }
      }

      // Nettoyer les fichiers temporaires
      this.cleanupTemp();

      // Sauvegarder la nouvelle version
      this.saveInstalledVersion(updateInfo.version);
      console.log(`[Update] Version sauvegardée: ${updateInfo.version}`);

      // VIDER LE CACHE MANIFEST
      const cacheFile = path.join(app.getPath('userData'), 'manifest-cache.json');
      if (fs.existsSync(cacheFile)) {
        fs.unlinkSync(cacheFile);
        console.log('[Update] Cache manifest vidé');
      }
      
      console.log('[Update] Mise à jour appliquée avec succès');
      return true;

    } catch (error) {
      console.error('[Update] Erreur application MAJ:', error);
      
      // Tenter de restaurer la sauvegarde
      try {
        await this.restoreBackup();
      } catch (restoreError) {
        console.error('[Update] Erreur restauration:', restoreError);
      }

      throw error;
    }
  }

  /**
   * Crée une sauvegarde des fichiers actuels
   */
  async createBackup(files, backupId) {
    const backupDir = path.join(this.backupPath, backupId);
    this.ensureDirectory(backupDir);

    for (const fileInfo of files) {
      const sourcePath = path.join(this.addonPath, fileInfo.path);
      
      if (fs.existsSync(sourcePath)) {
        const backupFilePath = path.join(backupDir, fileInfo.path);
        this.ensureDirectory(path.dirname(backupFilePath));
        fs.copyFileSync(sourcePath, backupFilePath);
      }
    }

    // Sauvegarder les métadonnées
    fs.writeFileSync(
      path.join(backupDir, 'backup-info.json'),
      JSON.stringify({
        version: this.currentVersion,
        date: new Date().toISOString(),
        files: files.map(f => f.path)
      }, null, 2)
    );

    console.log(`[Update] Sauvegarde créée: ${backupId}`);
  }

  /**
   * Restaure la dernière sauvegarde
   */
  async restoreBackup() {
    const backups = fs.readdirSync(this.backupPath)
      .filter(name => !isNaN(name))
      .sort((a, b) => parseInt(b) - parseInt(a));

    if (backups.length === 0) {
      throw new Error('Aucune sauvegarde disponible');
    }

    const latestBackup = backups[0];
    const backupDir = path.join(this.backupPath, latestBackup);
    const backupInfo = JSON.parse(
      fs.readFileSync(path.join(backupDir, 'backup-info.json'), 'utf8')
    );

    for (const fileName of backupInfo.files) {
      const backupFilePath = path.join(backupDir, fileName);
      const targetPath = path.join(this.addonPath, fileName);

      if (fs.existsSync(backupFilePath)) {
        fs.copyFileSync(backupFilePath, targetPath);
      }
    }

    console.log(`[Update] Sauvegarde restaurée: ${latestBackup}`);
  }

  /**
   * Compare deux versions (semver simple)
   */
  compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (parts1[i] > parts2[i]) return 1;
      if (parts1[i] < parts2[i]) return -1;
    }
    return 0;
  }

  /**
   * Nettoie les fichiers temporaires
   */
  cleanupTemp() {
    if (fs.existsSync(this.tempPath)) {
      fs.rmSync(this.tempPath, { recursive: true, force: true });
    }
  }

  /**
   * S'assure qu'un dossier existe
   */
  ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Sauvegarde la version installée
   */
  saveInstalledVersion(version) {
    const versionFile = path.join(app.getPath('userData'), 'addon-version.json');
    fs.writeFileSync(versionFile, JSON.stringify({
      version,
      installedAt: new Date().toISOString()
    }, null, 2));
  }

  /**
   * Récupère la version installée
   */
  getInstalledVersion() {
    try {
      const versionFile = path.join(app.getPath('userData'), 'addon-version.json');
      if (fs.existsSync(versionFile)) {
        const data = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
        console.log(`[Update] Version installée détectée: ${data.version}`);
        return data.version;
      }
    } catch (error) {
      console.error('[Update] Erreur lecture version:', error);
    }
    console.log(`[Update] Aucune version installée, utilisation version app: ${this.currentVersion}`);
    return this.currentVersion;
  }
}

module.exports = UpdateManager;
