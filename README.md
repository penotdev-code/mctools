# 🧰 Boîte à outils

Un portail « multi-tool » pour un client qui gère du foncier (terrains, finances) :
une page d'accueil qui rassemble des petits outils (documents, images, foncier, finances…).

- **En ligne** : <https://mctools.paulpenot.fr> (protégé par un mot de passe partagé)
- **Hébergement** : VPS OVH, derrière Traefik (HTTPS automatique) — voir le dépôt `VPS1`

## Structure

```
config.json              nom de l'appli, slogan, catégories
server/server.js         serveur Node (zéro dépendance) : portail, outils, API
public/                  portail (accueil) + styles et en-tête communs
tools/<id>/              un dossier par outil (détecté automatiquement)
  tool.json              nom, icône, catégorie, description, statut
  index.html, app.js     l'interface de l'outil (servie sur /outils/<id>/)
  api.js                 (optionnel) partie serveur, sur /api/tools/<id>/…
tools/_modele/           modèle à copier pour créer un outil
```

## Ajouter un outil

1. Copier `tools/_modele` vers `tools/mon-outil` (minuscules, chiffres, tirets).
2. Remplir `tool.json` :
   - `category` : un `id` de `config.json` ;
   - `status` : `ready`, ou `soon` pour l'afficher grisé avec « Bientôt ».
3. Écrire l'interface dans `index.html` (+ `app.js`). L'en-tête commun vient de `/js/tool-shell.js`, les styles de `/css/app.css`.
4. Si l'outil a besoin du serveur (fichiers lourds, conversions…) : renommer `api.js.exemple` en `api.js`.

Par défaut, on traite les fichiers **dans le navigateur** quand c'est possible : les documents du client ne quittent pas son ordinateur.

## Tester en local

```bash
node server/server.js     # puis http://localhost:3000
```

## Déploiement

À chaque push sur `main`, GitHub Actions se connecte au VPS avec une clé limitée au déploiement et relance l'appli (`.github/workflows/deploy.yml`, secret `VPS_SSH_KEY`).

Le mot de passe partagé est stocké sur le serveur dans `.env` (`BASIC_AUTH_USERS`), jamais dans le dépôt.
