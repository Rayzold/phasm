# PhasmListener — αυτόματο άκουσμα βημάτων για το Phasmo Journal

Μικρό Windows app που ακούει **μόνο** τον ήχο του Phasmophobia (όχι Discord, μουσική, browser)
και τον στέλνει στο [Phasmo Journal](https://rayzold.github.io/phasm/#hunt-toolkit).
Το Journal βρίσκει τα βήματα του ghost στο hunt και δείχνει live **BPM → m/s** και ποια ghosts ταιριάζουν,
στον ίδιο Footstep Speed Tapper (το χειροκίνητο TAP δουλεύει πάντα ως fallback).

## Χρήση

1. Κατέβασε το `PhasmListener.exe` (GitHub Actions artifact ή Release) και άνοιξέ το. Μένει ανοιχτό ένα μικρό
   παράθυρο κονσόλας: `Waiting for Phasmophobia.exe …` → `Listening to Phasmophobia.exe`.
2. Στο Journal → **Hunt Toolkit** → 🎧 → πάτα **🖥️ PhasmListener**.
3. Την πρώτη φορά ο Chrome/Edge ρωτάει για **πρόσβαση σε τοπικό δίκτυο** (Local Network Access) → **Allow**.
   Είναι η σύνδεση στο `ws://localhost:47213`, τίποτα δεν βγαίνει εκτός υπολογιστή.
4. Στο hunt μείνε ακίνητος (τα δικά σου βήματα μπερδεύουν τη μέτρηση). Μετά από ~4 βήματα εμφανίζεται η ταχύτητα·
   κίτρινο = χαμηλή σιγουριά (δεν επιτρέπεται φίλτρο), πράσινο = σίγουρο.

Δεν θέλεις να εγκαταστήσεις τίποτα; Το κουμπί **🔊 Ήχος συστήματος** κάνει το ίδιο μέσω screen share
(«Share system audio»), αλλά ακούει και Discord/μουσική.

### Απαιτήσεις
- Windows 11 ή Windows 10 build 20348+ (per-process loopback του WASAPI).
- Χωρίς admin, χωρίς firewall prompt: ακούει μόνο σε loopback (`127.0.0.1` / `::1`).
- Συνδέονται μόνο `https://rayzold.github.io` και `localhost` (άλλα sites παίρνουν 403).

### Επιλογές
```
PhasmListener.exe --port 47213            άλλη θύρα (το Journal διαβάζει τη θύρα από localStorage "phasm-ear-v1".port)
PhasmListener.exe --process Phasmophobia  άλλο process
PhasmListener.exe --allow-origin http://192.168.1.10:8123
PhasmListener.exe --wav ηχογράφηση.wav --loop   παίζει WAV αντί για το game (tuning/tests, τρέχει και σε Linux/macOS)
```

## Build

```
dotnet publish footstep-helper -c Release -r win-x64      →  bin/Release/net8.0/win-x64/publish/PhasmListener.exe
```
Self-contained single file, δεν χρειάζεται .NET runtime στον υπολογιστή. Χωρίς NuGet dependencies.
Το workflow `.github/workflows/phasm-listener.yml` το βγάζει αυτόματα σε κάθε αλλαγή εδώ
(artifact) και ως GitHub Release όταν γίνει push tag `listener-v*`.

Χωρίς RID (`dotnet build`) βγαίνει framework-dependent `PhasmListener.dll` → `dotnet PhasmListener.dll`.

## Πώς δουλεύει

```
Phasmophobia.exe ──(WASAPI process loopback, 48 kHz stereo float)──► PhasmListener
   ► downmix + anti-alias + 16 kHz mono s16le, 20 ms frames
   ► WebSocket ws://localhost:47213 ─────────────────────────────────► Journal (footsteps.js)
       band-pass 70 Hz–2 kHz → ενέργεια / 5 ms → onset (πάνω από θόρυβο + απότομη άνοδος + γρήγορη απόσβεση)
       → ανθεκτική περίοδος (αντέχει χαμένα/ψεύτικα βήματα) → v = bpm / (60 + 0.075·bpm)
```

Όλη η ανίχνευση είναι στο `footsteps.js` του site: αλλαγές στον αλγόριθμο δεν θέλουν νέο `.exe`.
Tests: `node tests/footsteps.test.js` (συνθετικά βήματα 0.4–3.71 m/s με θόρυβο, χαμένα βήματα, φωνές).

Text frames (JSON): `{"type":"hello","sampleRate":16000,"format":"s16le-mono"}`,
`{"type":"status","state":"waiting|capturing|error","pid":1234,"message":"…"}`. Binary frames: 320 δείγματα int16 LE.

Third-party: δες [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
