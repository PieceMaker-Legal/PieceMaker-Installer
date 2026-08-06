#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gestion des dossiers juridiques"""

import os
import json
from typing import Dict, Any, Optional, List


class CaseManager:
    """Gestionnaire de dossiers juridiques"""
    
    def __init__(self):
        self._data_path: Optional[str] = None
    
    def set_data_path(self, path: str) -> None:
        """Définit le chemin racine des dossiers"""
        self._data_path = path
    
    def get_case_path(self, case_id: str) -> Optional[str]:
        """Retourne le chemin complet d'un dossier"""
        if not self._data_path:
            return None
        path = os.path.join(self._data_path, case_id)
        return path if os.path.exists(path) else None
    
    def list_cases(self) -> List[Dict[str, Any]]:
        """Liste tous les dossiers disponibles"""
        if not self._data_path or not os.path.exists(self._data_path):
            return []

        cases = []
        for item in os.listdir(self._data_path):
            case_path = os.path.join(self._data_path, item)
            if os.path.isdir(case_path):
                info = {"id": item, "path": case_path}

                # Chercher le fichier compilation_dossier*.json
                compilation_file = None
                for file_item in os.listdir(case_path):
                    if "compilation_dossier" in file_item.lower() and file_item.endswith('.json'):
                        compilation_file = os.path.join(case_path, file_item)
                        break

                if compilation_file and os.path.exists(compilation_file):
                    try:
                        with open(compilation_file, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                            info["nom"] = data.get("nom_dossier", item)
                            info["type"] = data.get("type_ecriture", "non défini")
                            info["compilation_file"] = os.path.basename(compilation_file)
                    except (json.JSONDecodeError, IOError):
                        info["nom"] = item
                        info["type"] = "erreur lecture"
                else:
                    info["nom"] = item
                    info["type"] = "pas de compilation_dossier.json"

                cases.append(info)

        return cases
    
    def load_case(self, case_id: str) -> Dict[str, Any]:
        """Charge les données d'un dossier (JSON source) via case_id (ancienne méthode)"""
        case_path = self.get_case_path(case_id)

        if not case_path:
            return {"success": False, "error": f"Dossier '{case_id}' introuvable"}

        return self.load_case_from_path(case_path)

    def find_and_load_case(self, search_term: str) -> Dict[str, Any]:
        """Recherche un dossier par terme partiel (insensible à la casse) et le charge"""
        if not self._data_path or not os.path.exists(self._data_path):
            # Si pas de data_path, essayer de charger directement
            return self.load_case_from_path(search_term)

        # Recherche dans les dossiers disponibles
        search_lower = search_term.lower()
        cases = self.list_cases()

        # Recherche exacte d'abord
        for case in cases:
            if case['id'].lower() == search_lower:
                return self.load_case_from_path(case['path'])

        # Recherche partielle
        matches = []
        for case in cases:
            if search_lower in case['id'].lower():
                matches.append(case)

        if len(matches) == 0:
            # Aucune correspondance, essayer de charger directement le chemin
            return self.load_case_from_path(search_term)
        elif len(matches) == 1:
            # Une seule correspondance, charger ce dossier
            return self.load_case_from_path(matches[0]['path'])
        else:
            # Plusieurs correspondances
            match_list = "\n".join([f"  - {m['id']}" for m in matches])
            return {
                "success": False,
                "error": f"Plusieurs dossiers correspondent à '{search_term}':\n{match_list}\n\nVeuillez être plus précis."
            }

    def load_case_from_path(self, path: str) -> Dict[str, Any]:
        """Charge les données d'un dossier à partir d'un chemin"""
        # Normaliser le chemin
        # Si le chemin est relatif et qu'un _data_path est défini, l'utiliser comme base
        if not os.path.isabs(path) and self._data_path:
            case_path = os.path.abspath(os.path.join(self._data_path, path))
        else:
            case_path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'existe pas"}

        if not os.path.isdir(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'est pas un dossier"}

        # Chercher le fichier principal avec "compilation_dossier" dans le nom
        compilation_file = None
        for item in os.listdir(case_path):
            if "compilation_dossier" in item.lower() and item.endswith('.json'):
                compilation_file = os.path.join(case_path, item)
                break

        if not compilation_file:
            return {"success": False, "error": "Aucun fichier 'compilation_dossier*.json' trouvé dans le dossier"}

        try:
            # Charger le fichier principal
            with open(compilation_file, 'r', encoding='utf-8') as f:
                case_data = json.load(f)

            # Extraire le nom du dossier
            folder_name = os.path.basename(case_path)

            # Lister tous les fichiers JSON et HTML disponibles
            all_files = self._list_all_accessible_files(case_path)

            # Charger tous les fichiers JSON du dossier
            all_json_data = {}
            for json_file in all_files['json']:
                json_path = os.path.join(case_path, json_file)
                try:
                    with open(json_path, 'r', encoding='utf-8') as f:
                        all_json_data[json_file] = json.load(f)
                except (json.JSONDecodeError, IOError) as e:
                    all_json_data[json_file] = {"error": f"Erreur lecture: {str(e)}"}

            # Ajouter métadonnées
            case_data["_meta"] = {
                "case_id": folder_name,
                "path": case_path,
                "compilation_file": os.path.basename(compilation_file),
                "files": all_files,
                "all_json_data": all_json_data
            }

            return {"success": True, "data": case_data, "folder_name": folder_name}

        except json.JSONDecodeError as e:
            return {"success": False, "error": f"JSON invalide dans '{os.path.basename(compilation_file)}': {str(e)}"}
        except IOError as e:
            return {"success": False, "error": f"Erreur lecture: {str(e)}"}
    
    def _list_files(self, path: str) -> Dict[str, List[str]]:
        """Liste les fichiers par type"""
        files = {"json": [], "pdf": [], "docx": [], "txt": [], "autres": []}

        for item in os.listdir(path):
            if os.path.isfile(os.path.join(path, item)):
                ext = item.rsplit('.', 1)[-1].lower() if '.' in item else ''
                category = ext if ext in files else "autres"
                files[category].append(item)

        return files

    def _list_all_accessible_files(self, path: str) -> Dict[str, List[str]]:
        """Liste tous les fichiers accessibles (JSON et HTML principalement)"""
        files = {"json": [], "html": [], "pdf": [], "docx": [], "txt": [], "autres": []}

        for item in os.listdir(path):
            file_path = os.path.join(path, item)
            if os.path.isfile(file_path):
                ext = item.rsplit('.', 1)[-1].lower() if '.' in item else ''

                # Catégoriser les fichiers
                if ext == 'json':
                    files['json'].append(item)
                elif ext in ['html', 'htm']:
                    files['html'].append(item)
                elif ext == 'pdf':
                    files['pdf'].append(item)
                elif ext in ['docx', 'doc']:
                    files['docx'].append(item)
                elif ext == 'txt':
                    files['txt'].append(item)
                else:
                    files['autres'].append(item)

        return files
    
    def save_case_data(self, case_id: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Sauvegarde les données d'un dossier via case_id (ancienne méthode)"""
        case_path = self.get_case_path(case_id)

        if not case_path:
            return {"success": False, "error": "Dossier introuvable"}

        return self.save_case_data_to_path(case_path, data)

    def save_case_data_to_path(self, path: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Sauvegarde les données d'un dossier dans le fichier compilation_dossier"""
        # Normaliser le chemin
        if not os.path.isabs(path) and self._data_path:
            case_path = os.path.abspath(os.path.join(self._data_path, path))
        else:
            case_path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'existe pas"}

        if not os.path.isdir(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'est pas un dossier"}

        # Chercher le fichier compilation_dossier existant
        compilation_file = None
        for item in os.listdir(case_path):
            if "compilation_dossier" in item.lower() and item.endswith('.json'):
                compilation_file = os.path.join(case_path, item)
                break

        # Si aucun fichier n'existe, créer un nouveau fichier
        if not compilation_file:
            compilation_file = os.path.join(case_path, "Compilation_dossier.json")

        try:
            # Retirer les métadonnées avant sauvegarde
            data_to_save = {k: v for k, v in data.items() if not k.startswith('_')}

            with open(compilation_file, 'w', encoding='utf-8') as f:
                json.dump(data_to_save, f, ensure_ascii=False, indent=2)

            return {"success": True, "file": os.path.basename(compilation_file)}

        except IOError as e:
            return {"success": False, "error": str(e)}
    
    def get_parties(self, case_data: Dict[str, Any]) -> Dict[str, Any]:
        """Extrait les informations sur les parties"""
        parties = case_data.get("parties_presentes", [])
        client = case_data.get("client", {})
        adversaire = case_data.get("adversaire", {})
        
        return {
            "client": client,
            "adversaire": adversaire,
            "parties": parties,
            "nombre_parties": len(parties)
        }
    
    def get_documents(self, case_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extrait la liste des documents/pièces"""
        return case_data.get("documents", [])
    
    def get_faits(self, case_data: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Extrait les faits du dossier"""
        return case_data.get("faits", [])
    
    def get_procedure(self, case_data: Dict[str, Any]) -> Dict[str, Any]:
        """Extrait les informations de procédure"""
        return case_data.get("procedure", {})

    def write_to_html(self, path: str, html_content: str) -> Dict[str, Any]:
        """Écrit du contenu HTML dans le fichier document_content.html du dossier"""
        # Normaliser le chemin
        if not os.path.isabs(path) and self._data_path:
            case_path = os.path.abspath(os.path.join(self._data_path, path))
        else:
            case_path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'existe pas"}

        if not os.path.isdir(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'est pas un dossier"}

        html_file = os.path.join(case_path, "document_content.html")

        try:
            with open(html_file, 'w', encoding='utf-8') as f:
                f.write(html_content)

            return {"success": True, "file": html_file}

        except IOError as e:
            return {"success": False, "error": f"Erreur écriture: {str(e)}"}

    def append_to_html(self, path: str, html_content: str) -> Dict[str, Any]:
        """Ajoute du contenu HTML au fichier document_content.html du dossier"""
        # Normaliser le chemin
        if not os.path.isabs(path) and self._data_path:
            case_path = os.path.abspath(os.path.join(self._data_path, path))
        else:
            case_path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'existe pas"}

        if not os.path.isdir(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'est pas un dossier"}

        html_file = os.path.join(case_path, "document_content.html")

        try:
            # Lire le contenu existant s'il existe
            existing_content = ""
            if os.path.exists(html_file):
                with open(html_file, 'r', encoding='utf-8') as f:
                    existing_content = f.read()

            # Ajouter le nouveau contenu
            new_content = existing_content + "\n" + html_content

            with open(html_file, 'w', encoding='utf-8') as f:
                f.write(new_content)

            return {"success": True, "file": html_file}

        except IOError as e:
            return {"success": False, "error": f"Erreur écriture: {str(e)}"}

    def load_ecriture_json(self, path: str, type_ecriture: str) -> Dict[str, Any]:
        """Charge le fichier ecriture_{TYPE}.json ou crée la structure par défaut"""
        if not os.path.isabs(path) and self._data_path:
            case_path = os.path.abspath(os.path.join(self._data_path, path))
        else:
            case_path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'existe pas"}

        if not os.path.isdir(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'est pas un dossier"}

        ecriture_file = os.path.join(case_path, f"ecriture_{type_ecriture}.json")

        try:
            if os.path.exists(ecriture_file):
                with open(ecriture_file, 'r', encoding='utf-8') as f:
                    data = json.load(f)
            else:
                # Structure par défaut
                data = {
                    "titre_procedure": [{
                        "type_document": type_ecriture,
                        "pretentions": [],
                        "juridiction_competente": [{
                            "nom_juridiction": None,
                            "explication_AI": None
                        }],
                        "document_adverse": [],
                        "decision_precedente": []
                    }],
                    "rédaction": [{
                        "présentation_client": None,
                        "position_client": "demandeur",
                        "présentation_partie_adverse": None,
                        "position_partie_adverse": None,
                        "présentation_autres": None
                    }]
                }

            return {"success": True, "data": data, "file": ecriture_file}

        except json.JSONDecodeError as e:
            return {"success": False, "error": f"JSON invalide: {str(e)}"}
        except IOError as e:
            return {"success": False, "error": f"Erreur lecture: {str(e)}"}

    def save_ecriture_json(self, path: str, type_ecriture: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Sauvegarde le fichier ecriture_{TYPE}.json"""
        if not os.path.isabs(path) and self._data_path:
            case_path = os.path.abspath(os.path.join(self._data_path, path))
        else:
            case_path = os.path.abspath(os.path.expanduser(path))

        if not os.path.exists(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'existe pas"}

        if not os.path.isdir(case_path):
            return {"success": False, "error": f"Le chemin '{path}' n'est pas un dossier"}

        ecriture_file = os.path.join(case_path, f"ecriture_{type_ecriture}.json")

        try:
            with open(ecriture_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            return {"success": True, "file": ecriture_file}

        except IOError as e:
            return {"success": False, "error": f"Erreur écriture: {str(e)}"}


# Instance globale
case_manager = CaseManager()
