# Kusic

Agrégateur de playlists Spotify & SoundCloud avec téléchargement via Soulseek. Application desktop Electron (Windows).

## Fonctionnalités

- Importer des playlists **Spotify** et **SoundCloud**, vue unifiée de toutes les pistes (une piste présente dans plusieurs playlists n'apparaît qu'une fois)
- Filtres : source, playlist, **manquantes** (pistes sans fichier local), recherche, tri
- Vue détail d'une playlist avec taux de complétion et **export `.m3u`**
- Recherche **Soulseek** intégrée (via [slskd](https://github.com/slskd/slskd), installé et piloté par l'app)
  - filtres format / bitrate / slot libre, tri, comparaison de durée avec la piste
  - recherche auto des pistes manquantes : **recherche uniquement**, aucun téléchargement automatique
  - cache des résultats conservé entre les redémarrages
- Les fichiers téléchargés sont tagués (titre, artiste, album, lien `[KUSIC:id]`) et rangés en `Artiste - Titre.ext`
- **Conflits** : si une piste a déjà un fichier ou si le nom est pris, rien n'est écrasé ; vous comparez les deux fichiers et choisissez lequel garder (l'autre va à la corbeille)
- Identification assistée des fichiers inconnus (suggestions classées, lien uniquement sur clic)
- Amélioration de qualité manuelle (recherche FLAC pour les pistes en MP3)

## Prérequis

- Windows 10/11
- Node.js 20+ (Node 22.12+ nécessaire pour passer à Electron ≥ 40)

## Installation & lancement

```bash
npm install
npm start          # build + lancement
npm run dev        # idem avec les DevTools
npm test           # tests unitaires (vitest)
npm run typecheck
npm run dist       # installeur Windows dans release/
```

## Configuration

### Spotify

1. Créez une application sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Copiez le **Client ID** et le **Client Secret** dans **Paramètres → Spotify API**, puis cliquez sur **Tester**

> Depuis février 2026, les apps Spotify en mode développement nécessitent un compte Premium pour leur propriétaire, et les playlists générées par Spotify ne sont pas accessibles via l'API.

### SoundCloud

Aucune configuration : le `client_id` public est récupéré automatiquement.

### Soulseek

Dans **Paramètres → Soulseek** : pseudo, mot de passe, dossier de la bibliothèque (téléchargements + partage), puis **Télécharger slskd** et **Démarrer**.

- slskd n'écoute que sur `127.0.0.1` et son API est protégée par une clé générée localement
- le mot de passe est transmis à slskd par variable d'environnement (jamais écrit dans `slskd.yml`)
- les téléchargements en cours sont stockés hors du dossier partagé
- slskd est arrêté à la fermeture de Kusic

## Données locales (`%APPDATA%\kusic`)

| Fichier / dossier | Contenu |
| --- | --- |
| `config.json` | paramètres, playlists, index des pistes, conflits |
| `scan-cache.json` | cache du scan des fichiers locaux |
| `downloads.json` | téléchargements en attente de rangement (lien transfert → piste) |
| `search-cache.json`, `search-cache/` | résultats de recherche Soulseek (3 jours) |
| `covers/` | miniatures des pochettes (cache, peut être supprimé) |
| `slskd/` | binaire, configuration et données de slskd |

## Structure du projet

```
src/
├── main/                    # Process principal (TypeScript, ESM)
│   ├── main.ts              # Fenêtre, cycle de vie, handlers IPC
│   ├── preload.cts          # Bridge contextBridge (CommonJS)
│   ├── store.ts             # Stores persistants
│   ├── downloads.ts         # Suivi des téléchargements → rangement
│   ├── search-cache.ts      # Cache des recherches Soulseek
│   └── library/
│       ├── library.ts       # Playlists, index, placement des fichiers, conflits
│       ├── indexer.ts       # Construction de l'index unifié (pur)
│       ├── naming.ts        # Noms de fichiers, tag KUSIC (pur)
│       ├── files.ts         # Scan, tags, déplacements
│       └── covers.ts        # Miniatures + protocole kusic-cover://
├── services/
│   ├── spotify.ts
│   ├── soundcloud.ts
│   └── slskd/               # Client API, config, gestion du processus
├── renderer/                # Interface (HTML/CSS + modules ES)
│   ├── index.html
│   ├── styles.css
│   └── js/                  # main, tracks, playlists, search, downloads, conflicts, identify, settings, ui
└── types.ts                 # Types partagés
```
