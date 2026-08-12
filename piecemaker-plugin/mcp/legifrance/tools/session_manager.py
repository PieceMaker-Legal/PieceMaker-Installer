#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Gestion des sessions utilisateur et authentification"""

from datetime import datetime
from typing import Dict, Any, Optional


class SessionManager:
    """Gestionnaire de sessions utilisateur"""
    
    def __init__(self):
        self._sessions: Dict[str, Dict[str, Any]] = {}
    
    def set_session(self, user_id: str, data: Dict[str, Any]) -> None:
        """Définit les données de session pour un utilisateur"""
        if user_id not in self._sessions:
            self._sessions[user_id] = {}
        self._sessions[user_id].update(data)
        self._sessions[user_id]['last_activity'] = datetime.now()
    
    def get_session(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Récupère les données de session d'un utilisateur"""
        return self._sessions.get(user_id)
    
    def set_current_case(self, user_id: str, case_id: str, case_data: Dict[str, Any]) -> None:
        """Définit le dossier actif et ses données"""
        self.set_session(user_id, {
            'current_case_id': case_id,
            'case_data': case_data
        })
    
    def get_current_case(self, user_id: str) -> Optional[str]:
        """Récupère l'ID du dossier actif"""
        session = self.get_session(user_id)
        return session.get('current_case_id') if session else None
    
    def get_case_data(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Récupère les données du dossier actif"""
        session = self.get_session(user_id)
        return session.get('case_data') if session else None
    
    def set_workflow_var(self, user_id: str, var_name: str, value: Any) -> None:
        """Définit une variable de workflow pour les conclusions"""
        session = self.get_session(user_id) or {}
        if 'workflow' not in session:
            session['workflow'] = {}
        session['workflow'][var_name] = value
        self.set_session(user_id, session)
    
    def get_workflow_var(self, user_id: str, var_name: str) -> Optional[Any]:
        """Récupère une variable de workflow"""
        session = self.get_session(user_id)
        if session and 'workflow' in session:
            return session['workflow'].get(var_name)
        return None
    
    def get_all_workflow_vars(self, user_id: str) -> Dict[str, Any]:
        """Récupère toutes les variables de workflow"""
        session = self.get_session(user_id)
        if session and 'workflow' in session:
            return session['workflow']
        return {}
    
    def clear_workflow(self, user_id: str) -> None:
        """Réinitialise le workflow"""
        session = self.get_session(user_id)
        if session:
            session['workflow'] = {}
            self.set_session(user_id, session)

def close_session(self, user_id: str) -> None:
    """Ferme une session et nettoie les fichiers temporaires"""
    from tools.document_generator import document_generator
    
    # Nettoyer les fichiers générés
    document_generator.cleanup_session(user_id)
    
    # Supprimer la session
    if user_id in self._sessions:
        del self._sessions[user_id]

# Instance globale
session_manager = SessionManager()
