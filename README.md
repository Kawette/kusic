# Kusic

Agrégateur de playlists Spotify & SoundCloud — Application desktop Electron.

## Fonctionnalités

- Importer des playlists depuis **Spotify** et **SoundCloud**
- Vue unifiée de toutes les pistes dans un seul listing
- Recherche, filtrage par source, tri par titre/artiste/durée
- Gestion de la bibliothèque musicale locale
- Interface sombre moderne

## Installation

```bash
npm install
```

## Lancement

```bash
npm start
```

Mode développement (ouvre les DevTools) :

```bash
npm run dev
```

## Configuration

### Spotify

1. Allez sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Créez une nouvelle application
3. Copiez le **Client ID** et **Client Secret**
4. Collez-les dans **Paramètres → Spotify API** dans l'app

### SoundCloud

Aucune configuration nécessaire — le client ID est résolu automatiquement.

## Structure du projet

```
kusic/
├── package.json
├── src/
│   ├── main/
│   │   ├── main.js          # Process principal Electron
│   │   └── preload.js       # Bridge sécurisé (contextBridge)
│   ├── renderer/
│   │   ├── index.html        # Interface utilisateur
│   │   ├── styles.css         # Styles (thème sombre)
│   │   └── renderer.js       # Logique frontend
│   └── services/
│       ├── spotify.js         # Intégration Spotify Web API
│       └── soundcloud.js      # Intégration SoundCloud API
```

## Prochaines étapes

- [ ] Téléchargement des pistes (via yt-dlp ou équivalent)
- [ ] Lecture audio intégrée
- [ ] Export de la bibliothèque unifiée
- [ ] Détection des doublons avancée (BPM, key)
