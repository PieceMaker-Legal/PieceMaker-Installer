/**
 * Module d'extraction de texte côté client
 * Extrait le texte des fichiers PDF, DOCX, TXT avant envoi au serveur
 * Évite le transfert de fichiers lourds et accélère le traitement
 */

// Import des librairies (chargées via CDN dans taskpane.html)
// pdfjs-dist: extraction PDF
// mammoth: extraction DOCX

const TextExtractor = {

    /**
     * Extrait le texte d'un fichier selon son type
     * @param {File} file - Le fichier à traiter
     * @param {Function} progressCallback - Callback pour progression OCR (optionnel)
     * @returns {Promise<Object>} - {fileName, fileType, text, error}
     */
    async extractText(file, progressCallback = null) {
        console.log(`[TextExtractor] Extraction de ${file.name} (${file.size} octets)`);

        const result = {
            fileName: file.name,
            fileType: this._getFileType(file.name),
            text: '',
            error: null
        };

        // Stocker le callback pour l'OCR
        this._currentProgressCallback = progressCallback;

        try {
            switch (result.fileType) {
                case 'pdf':
                    result.text = await this._extractFromPDF(file);
                    break;
                case 'docx':
                    result.text = await this._extractFromDOCX(file);
                    break;
                case 'txt':
                    result.text = await this._extractFromTXT(file);
                    break;
                case 'doc':
                    // .doc ancien format non supporté par mammoth
                    result.error = 'Format .doc non supporté. Veuillez convertir en .docx';
                    break;
                default:
                    result.error = `Type de fichier non supporté: ${result.fileType}`;
            }

            if (result.text) {
                console.log(`✅ [TextExtractor] ${file.name}: ${result.text.length} caractères extraits`);
            } else if (!result.error) {
                result.error = 'Aucun texte extrait du fichier';
            }

        } catch (error) {
            console.error(`❌ [TextExtractor] Erreur extraction ${file.name}:`, error);
            result.error = error.message || 'Erreur lors de l\'extraction';
        }

        return result;
    },

    /**
     * Détermine le type de fichier par son extension
     */
    _getFileType(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        return ext;
    },

    /**
     * Extrait le texte d'un PDF avec PDF.js
     */
    async _extractFromPDF(file) {
        console.log(`[PDF] Début extraction ${file.name}`);

        // Vérifier que PDF.js est chargé
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('PDF.js non chargé. Vérifiez que pdfjs-dist est inclus dans taskpane.html');
        }

        // Configurer le worker PDF.js
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        // Lire le fichier en ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        // Charger le PDF
        const loadingTask = pdfjsLib.getDocument({data: arrayBuffer});
        const pdf = await loadingTask.promise;

        console.log(`[PDF] ${pdf.numPages} pages détectées`);

        // Extraire le texte de chaque page
        const textParts = [];
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map(item => item.str).join(' ');

            if (pageText.trim()) {
                textParts.push(pageText);
                console.log(`[PDF] Page ${pageNum}: ${pageText.length} caractères`);
            }
        }

        if (textParts.length === 0) {
            console.warn(`[PDF] Aucun texte extrait - PDF probablement scanné, tentative OCR...`);
            // Tenter l'OCR avec Tesseract.js
            const ocrText = await this._extractFromPDFWithOCR(pdf, file.name);
            return ocrText;
        }

        // Normaliser : \n\n devient " \n ", \n devient " "
        return textParts.join('\n\n').replace(/\n\n/g, ' \n ').replace(/\n/g, ' ').replace(/ +/g, ' ');
    },

    /**
     * Extrait le texte d'un PDF scanné avec OCR (Tesseract.js)
     * @param {PDFDocumentProxy} pdf - Le document PDF déjà chargé
     * @param {string} fileName - Nom du fichier (pour logs)
     */
    async _extractFromPDFWithOCR(pdf, fileName) {
        console.log(`[OCR] Début OCR sur ${fileName} (${pdf.numPages} pages)`);

        // Vérifier que Tesseract est chargé
        if (typeof Tesseract === 'undefined') {
            console.error('[OCR] Tesseract.js non chargé');
            return '⚠️ PDF scanné détecté. OCR non disponible (Tesseract manquant).';
        }

        const totalPages = pdf.numPages;
        const WORKERS_COUNT = Math.min(3, totalPages); // Maximum 3 workers pour traitement parallèle

        try {
            // Créer un scheduler avec plusieurs workers pour traitement parallèle
            console.log(`[OCR] Initialisation du scheduler Tesseract avec ${WORKERS_COUNT} worker(s)...`);
            const scheduler = Tesseract.createScheduler();

            // Créer et ajouter les workers au scheduler
            const workers = [];
            for (let i = 0; i < WORKERS_COUNT; i++) {
                const worker = await Tesseract.createWorker({
                    logger: m => {
                        if (m.status === 'recognizing text') {
                            const progress = Math.round(m.progress * 100);
                        }
                    }
                });
                await worker.loadLanguage('fra');
                await worker.initialize('fra');
                scheduler.addWorker(worker);
                workers.push(worker);
            }

            console.log(`✅ [OCR] Scheduler prêt avec ${WORKERS_COUNT} worker(s)`);

            // Fonction pour traiter une page
            const processPage = async (pageNum) => {

                const page = await pdf.getPage(pageNum);

                // Convertir la page en canvas (image)
                const viewport = page.getViewport({ scale: 2.0 });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.width = viewport.width;
                canvas.height = viewport.height;

                await page.render({
                    canvasContext: context,
                    viewport: viewport
                }).promise;

                // Extraire l'image du canvas
                const imageData = canvas.toDataURL('image/png');

                console.log(`[OCR] Page ${pageNum} convertie en image (${viewport.width}x${viewport.height})`);

                // OCR avec le scheduler (gère automatiquement la répartition sur les workers)
                const result = await scheduler.addJob('recognize', imageData);

                const pageText = result.data.text.trim();

                if (this._currentProgressCallback) {
                    this._currentProgressCallback(`OCR page ${pageNum}/${totalPages} terminée`);
                }

                if (pageText) {
                    console.log(`[OCR] Page ${pageNum}: ${pageText.length} caractères extraits`);
                } else {
                    console.warn(`[OCR] Page ${pageNum}: aucun texte détecté`);
                }

                return { pageNum, text: pageText };
            };

            // Traiter toutes les pages en parallèle via le scheduler
            const pagePromises = [];
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                pagePromises.push(processPage(pageNum));
            }

            // Attendre que toutes les pages soient traitées
            const results = await Promise.all(pagePromises);

            // Terminer le scheduler et tous les workers
            await scheduler.terminate();
            console.log(`✅ [OCR] Scheduler et workers terminés`);

            // Trier les résultats par numéro de page et extraire le texte
            results.sort((a, b) => a.pageNum - b.pageNum);
            const textParts = results.map(r => r.text).filter(text => text);

            if (textParts.length === 0) {
                console.error('[OCR] Aucun texte extrait après OCR');
                return '⚠️ PDF scanné - OCR n\'a détecté aucun texte.';
            }

            // Joindre et normaliser les retours à la ligne pour les regex
            const totalText = textParts.join(' \n ').replace(/\n/g, ' ').replace(/ +/g, ' ');
            console.log(`✅ [OCR] Terminé: ${totalText.length} caractères extraits de ${fileName} (${totalPages} pages)`);

            return totalText;

        } catch (error) {
            console.error(`[OCR] Erreur:`, error);
            const errorMsg = error?.message || error?.toString() || 'Erreur inconnue';
            return `⚠️ Erreur OCR: ${errorMsg}`;
        }
    },

    /**
     * Extrait le texte d'un DOCX avec mammoth
     */
    async _extractFromDOCX(file) {
        console.log(`[DOCX] Début extraction ${file.name}`);

        // Vérifier que mammoth est chargé
        if (typeof mammoth === 'undefined') {
            throw new Error('Mammoth non chargé. Vérifiez que mammoth est inclus dans taskpane.html');
        }

        // Lire le fichier en ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();

        // Extraire le texte avec mammoth
        const result = await mammoth.extractRawText({arrayBuffer: arrayBuffer});

        if (result.messages && result.messages.length > 0) {
            console.warn(`[DOCX] Avertissements:`, result.messages);
        }

        console.log(`[DOCX] ${result.value.length} caractères extraits`);
        return result.value;
    },

    /**
     * Extrait le texte d'un fichier TXT
     */
    async _extractFromTXT(file) {
        console.log(`[TXT] Début extraction ${file.name}`);

        // Lire le fichier comme texte
        const text = await file.text();

        console.log(`[TXT] ${text.length} caractères extraits`);
        return text;
    },

    /**
     * Traite plusieurs fichiers en parallèle
     * @param {FileList|Array} files - Liste de fichiers
     * @param {Function} progressCallback - Callback appelé pour progression: (current, total, message)
     * @returns {Promise<Array>} - Tableau de résultats {fileName, fileType, text, error}
     */
    async extractMultiple(files, progressCallback = null) {
        console.log(`[TextExtractor] Extraction de ${files.length} fichier(s)`);

        const CONCURRENT_FILES = 2; // Nombre de fichiers traités en parallèle
        const fileArray = Array.from(files);
        const results = [];
        let completedCount = 0;

        // Fonction pour traiter un fichier avec suivi de progression
        const processFile = async (file, index) => {
            const fileProgressCallback = (message) => {
                if (progressCallback) {
                    progressCallback(completedCount + 1, fileArray.length, message);
                }
            };

            if (progressCallback) {
                progressCallback(completedCount + 1, fileArray.length, `Extraction: ${file.name}`);
            }

            const result = await this.extractText(file, fileProgressCallback);
            completedCount++;
            return { index, result };
        };

        // Traiter les fichiers par lots parallèles
        for (let i = 0; i < fileArray.length; i += CONCURRENT_FILES) {
            const batch = [];
            for (let j = i; j < Math.min(i + CONCURRENT_FILES, fileArray.length); j++) {
                batch.push(processFile(fileArray[j], j));
            }

            console.log(`[TextExtractor] Traitement batch ${Math.floor(i / CONCURRENT_FILES) + 1} (fichiers ${i + 1}-${Math.min(i + CONCURRENT_FILES, fileArray.length)})`);
            const batchResults = await Promise.all(batch);
            results.push(...batchResults);
        }

        // Trier les résultats par index original pour conserver l'ordre
        results.sort((a, b) => a.index - b.index);
        const sortedResults = results.map(r => r.result);

        // Statistiques
        const successful = sortedResults.filter(r => !r.error).length;
        const failed = sortedResults.filter(r => r.error).length;
        const totalChars = sortedResults.reduce((sum, r) => sum + (r.text?.length || 0), 0);

        console.log(`[TextExtractor] Terminé: ${successful} réussis, ${failed} échoués, ${totalChars} caractères au total`);

        return sortedResults;
    }
};

// Export pour utilisation dans taskpane.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = TextExtractor;
}
