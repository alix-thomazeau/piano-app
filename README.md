# Piano Coach

Web app (iPad, hors-ligne) pour apprendre ses morceaux de piano, dans l'esprit de Flowkey :
la partition attend que tu joues la bonne note, entendue par le micro.

**Ouvrir l'app :** https://alix-thomazeau.github.io/piano-app/
Sur iPad : Safari → bouton Partager → **Sur l'écran d'accueil**.

## Fonctions (version de base)

- Import de fichiers **MusicXML** (`.musicxml`, `.xml`, `.mxl`) et **MIDI** (`.mid`)
- Deux vues : **Partition** (avec doigtés) ou **Notes qui tombent**, avec clavier lumineux
- **Mode attente** : écoute au micro (piano acoustique), notes justes en vert, fausses en rouge
- Mode **Tolérant** pour les accords (≈ 60 % des notes suffisent)
- Main gauche / main droite seule
- Bilan en fin de morceau : précision, temps, mesures à retravailler
- Écran **Tester le micro** : réglage de la sensibilité et enregistrement d'un échantillon

Les morceaux et la progression restent **sur l'appareil** (IndexedDB) : rien n'est envoyé en ligne.

## Trouver ses morceaux

1. [musescore.com](https://musescore.com) → chercher « titre + piano easy / intermediate »
2. Download → **MusicXML** (de préférence) ou MIDI
3. Dans l'app : **+ Importer**

## Technique

- HTML/JS sans build, modules ES ; [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org) pour la partition, [@tonejs/midi](https://github.com/Tonejs/Midi) pour le MIDI
- Détection : double analyse FFT (fenêtre longue 16384 pour la hauteur, courte 4096 pour les attaques),
  saillance harmonique par touche, bruit de fond par bande de 1/3 d'octave
- `test/detect.html` : banc de test hors-ligne de la détection (piano synthétique ou enregistrement)

Démo incluse : *Ode à la joie* (Beethoven, domaine public), arrangement simple avec doigtés.
