const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class Config {
  constructor() {
    // Chemin du fichier de configuration dans le dossier userData d'Electron
    this.configPath = path.join(app.getPath('userData'), 'piecemaker-config.json');
    this.config = this.load();
  }

  /**
   * Charge la configuration depuis le fichier
   * @returns {Object} Configuration
   */
  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('Erreur lecture config:', error);
    }

    // Configuration par défaut
    return {
      outputPath: null // null = utilise le chemin par défaut (addon/output)
    };
  }

  /**
   * Sauvegarde la configuration dans le fichier
   */
  save() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      console.log('✅ Configuration sauvegardée:', this.configPath);
    } catch (error) {
      console.error('❌ Erreur sauvegarde config:', error);
      throw error;
    }
  }

  /**
   * Obtient le chemin de sortie configuré
   * @param {string} defaultPath - Chemin par défaut si aucun n'est configuré
   * @returns {string} Chemin de sortie
   */
  getOutputPath(defaultPath) {
    return this.config.outputPath || defaultPath;
  }

  /**
   * Définit le chemin de sortie
   * @param {string} outputPath - Nouveau chemin de sortie
   */
  setOutputPath(outputPath) {
    this.config.outputPath = outputPath;
    this.save();
  }

  /**
   * Obtient toute la configuration
   * @returns {Object} Configuration complète
   */
  getAll() {
    return { ...this.config };
  }
}

module.exports = Config;
