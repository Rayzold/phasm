// Shared Phasmophobia ghost dataset — used by both index.html and questionnaire.html.
// Keep this the single source of truth for evidence/ghost/tell data; update here only.
const EV = [
  {k:"EMF", n:"EMF Level 5",     ic:"📡"},
  {k:"DOTS",n:"D.O.T.S.",        ic:"💠"},
  {k:"UV",  n:"Ultraviolet",     ic:"🖐️"},
  {k:"FRZ", n:"Freezing Temps",  ic:"❄️"},
  {k:"ORB", n:"Ghost Orbs",      ic:"🔮"},
  {k:"WRT", n:"Ghost Writing",   ic:"📖"},
  {k:"SB",  n:"Spirit Box",      ic:"📻"},
];
// thMax = ανώτατο sanity % στο οποίο το ghost μπορεί ακόμα να κάνει hunt (για ταξινόμηση/quick lookup).
// isAny = μπορεί να κάνει hunt σε ΟΠΟΙΟΔΗΠΟΤΕ sanity μέσω ability.
// variableTh = threshold που αλλάζει ανάλογα με behavior (π.χ. Mimic μιμείται άλλο ghost).
const GHOSTS = [
 {name:"Spirit", ev:["EMF","WRT","SB"], hunt:"50%", thMax:50, tell:"Κανένα φανερό tell — το «βαρετό» ghost. Test: μετά από incense/smudge δεν κάνει hunt για 180s (αντί 90s). Αν μετρήσεις 2-3 λεπτά ησυχίας μετά το smudge → Spirit."},
 {name:"Wraith", ev:["DOTS","EMF","SB"], hunt:"50%", thMax:50, tell:"Δεν πατάει ΠΟΤΕ salt — κανένα footprint, ποτέ. Ρίξε salt σε πέρασμα: αν όλα τα άλλα δείχνουν activity αλλά το salt μένει ανέγγιχτο, μεγάλο Wraith hint."},
 {name:"Phantom", ev:["DOTS","UV","SB"], hunt:"50%", thMax:50, tell:"Φωτογράφισέ το σε ghost event: αν ΔΕΝ φαίνεται στη φωτογραφία → Phantom. Σε hunt μένει αόρατο περισσότερη ώρα (αραιό flickering). Μην το κοιτάς — σου ρίχνει sanity."},
 {name:"Poltergeist", ev:["WRT","UV","SB"], hunt:"50%", thMax:50, tell:"Πετάει πολλά αντικείμενα μαζί και συχνά. Άσε ένα σωρό μικροαντικείμενα σε ένα δωμάτιο — αν τα εκτοξεύσει όλα μαζί (μεγάλο sanity drain), Poltergeist."},
 {name:"Banshee", ev:["DOTS","ORB","UV"], hunt:"50% του στόχου", thMax:50, tell:"Στοχεύει ΕΝΑΝ παίκτη (solo: εσένα). Χαρακτηριστική κραυγή στο Parabolic Microphone (~1/3 των ήχων). Κάνει «επισκέψεις» στον στόχο του αντί να roamάρει τυχαία."},
 {name:"Jinn", ev:["EMF","UV","FRZ"], hunt:"50%", thMax:50, tell:"Με breaker ON: γρήγορο από μακριά, κανονικό από κοντά. Δεν κλείνει ΠΟΤΕ το breaker το ίδιο. Ability του δίνει EMF στο breaker. Counter: κλείσε εσύ το breaker και γίνεται κανονικό."},
 {name:"Mare", ev:["WRT","ORB","SB"], hunt:"60% σκοτάδι / 40% φως", thMax:60, tell:"Σβήνει φώτα αμέσως μόλις τα ανάψεις, δεν ανάβει ΠΟΤΕ φως. Counter: κράτα το ghost room φωτισμένο και «κλειδώνει» στο 40% threshold — πολύ πιο ασφαλές."},
 {name:"Revenant", ev:["WRT","ORB","FRZ"], hunt:"50%", thMax:50, tell:"Δύο ταχύτητες: σαλιγκάρι (1.0 m/s) όταν δεν σε βλέπει, τέρας (3.0 m/s) όταν σε βλέπει. Counter: κρύψου ΑΜΕΣΩΣ — μόλις χάσει τα ίχνη σου σέρνεται."},
 {name:"Shade", ev:["WRT","EMF","FRZ"], hunt:"35%", thMax:35, tell:"Ντροπαλό: ελάχιστη δραστηριότητα όσο είσαι κοντά, δεν κάνει hunt αν είσαι στο ίδιο δωμάτιο. Αν το σπίτι είναι «νεκρό» σε activity αλλά υπάρχει ghost, σκέψου Shade."},
 {name:"Demon", ev:["WRT","UV","FRZ"], hunt:"70% + hunt σε ΟΠΟΙΟΔΗΠΟΤΕ sanity (ability)", thMax:100, isAny:true, tell:"Hunt με full sanity = σχεδόν σίγουρα Demon. Ελάχιστο cooldown μεταξύ hunts (20s αντί 25s). Counter: crucifix — πάνω του έχει μεγαλύτερη εμβέλεια."},
 {name:"Yurei", ev:["DOTS","ORB","FRZ"], hunt:"50%", thMax:50, tell:"Κλείνει πόρτες ΤΕΡΜΑ με δύναμη (ability που ρίχνει sanity). Counter: smudge ΜΕΣΑ στο δωμάτιό του το καθηλώνει εκεί για 90s — δεν roamάρει."},
 {name:"Oni", ev:["DOTS","EMF","FRZ"], hunt:"50%", thMax:50, tell:"Υπερδραστήριο όταν είσαι κοντά, πετάει αντικείμενα με μεγάλη δύναμη. Δεν κάνει ΠΟΤΕ το «airball» event. Σε hunt φαίνεται πιο καθαρά (λιγότερο flickering)."},
 {name:"Yokai", ev:["DOTS","ORB","SB"], hunt:"50% / 80% αν μιλάς κοντά του", thMax:80, tell:"Η φωνή σου το εξαγριώνει — αν τα hunts ξεκινούν όταν μιλάς, ύποπτο. Counter: σε hunt σε ακούει/εντοπίζει μόνο σε ~2.5m. Κρύψου, σώπα, και είσαι σχεδόν άτρωτος."},
 {name:"Hantu", ev:["ORB","UV","FRZ"], hunt:"50%", thMax:50, tell:"Πιο γρήγορο όσο πιο κρύο το δωμάτιο. Κλείνει το breaker, δεν το ανοίγει ΠΟΤΕ. Σε hunt με breaker off βγάζει παγωμένη ανάσα (100% confirm). Counter: κράτα το σπίτι ζεστό."},
 {name:"Goryo", ev:["DOTS","EMF","UV"], hunt:"50%", thMax:50, tell:"D.O.T.S. φαίνεται ΜΟΝΟ μέσα από video camera και μόνο όταν δεν είναι κανείς στο δωμάτιο. Δεν απομακρύνεται σχεδόν ποτέ από το ghost room του."},
 {name:"Myling", ev:["WRT","EMF","UV"], hunt:"50%", thMax:50, tell:"Σε hunt τα βήματα/φωνές του ακούγονται μόνο από πολύ κοντά — «αθόρυβος δολοφόνος». Στο Parabolic δίνει συχνότερους paranormal ήχους. Αν ακούς heartbeat χωρίς να το είχες ακούσει να έρχεται → Myling."},
 {name:"Onryo", ev:["ORB","FRZ","SB"], hunt:"60%", thMax:60, tell:"Ο δολοφόνος του τελευταίου σου run! Σβήνει φλόγες — κάθε 3η σβησμένη φλόγα = hunt, ανεξαρτήτως sanity. Counter: αναμμένο κερί/firelight δίπλα του δουλεύει σαν crucifix (μέχρι να το σβήσει)."},
 {name:"The Twins", ev:["EMF","FRZ","SB"], hunt:"50%", thMax:50, tell:"Interactions σε ΔΥΟ διαφορετικά σημεία σχεδόν ταυτόχρονα (το «δίδυμο» αλληλεπιδρά από απόσταση). Hunts με δύο ελαφρώς διαφορετικές ταχύτητες."},
 {name:"Raiju", ev:["DOTS","EMF","ORB"], hunt:"65% κοντά σε ηλεκτρονικά", thMax:65, tell:"Γρήγορο κοντά σε ΕΝΕΡΓΟ εξοπλισμό και κάνει hunt νωρίτερα δίπλα του. Παρασιτεί ηλεκτρονικά από μεγαλύτερη απόσταση. Counter: κλείσε/μάζεψε τον εξοπλισμό από το ghost room."},
 {name:"Obake", ev:["EMF","ORB","UV"], hunt:"50%", thMax:50, tell:"Fingerprints με 6 δάχτυλα ή περίεργα σχήματα = instant confirm. Τα prints του ξεθωριάζουν στον μισό χρόνο. Σε hunt αλλάζει στιγμιαία μορφή (shapeshift)."},
 {name:"The Mimic", ev:["UV","FRZ","SB"], mimic:true, hunt:"μιμείται άλλα", thMax:50, variableTh:true, tell:"Δείχνει ΠΑΝΤΑ ψεύτικα Ghost Orbs ως 4ο evidence. Αλλάζει συμπεριφορά κάθε λίγα λεπτά (τη μία Revenant, την άλλη Shade…). Αν το ghost «αλλάζει προσωπικότητα», Mimic."},
 {name:"Moroi", ev:["WRT","FRZ","SB"], hunt:"50%", thMax:50, tell:"Σε «καταριέται» μέσω Spirit Box ή Parabolic → το sanity σου πέφτει πιο γρήγορα μετά. Πιο γρήγορο όσο πέφτει το sanity σου. Counter: sanity pills σβήνουν την κατάρα, smudge το τυφλώνει παραπάνω."},
 {name:"Deogen", ev:["DOTS","WRT","SB"], hunt:"40%", thMax:40, tell:"Βαριά, λαχανιασμένη ανάσα στο Spirit Box από κοντινή απόσταση (unique). Σε hunt ΣΕ ΒΡΙΣΚΕΙ πάντα — μην κρυφτείς! Counter: από κοντά γίνεται πολύ αργό, κάνε loop γύρω από έπιπλα."},
 {name:"Thaye", ev:["DOTS","WRT","ORB"], hunt:"75% αρχικά → 15% τελικά", thMax:75, tell:"«Γερνάει»: ξεκινά υπερδραστήριο, γρήγορο και επιθετικό, και όσο περνά η ώρα (και είσαι κοντά του) γίνεται αργό και ήσυχο. Αν το ghost «κουράστηκε» → Thaye."},
 {name:"Dayan", ev:["EMF","ORB","SB"], hunt:"45% ακίνητος / 60% σε κίνηση", thMax:60, tell:"ΠΑΝΤΑ θηλυκό όνομα & μοντέλο (όπως και το Banshee). Κοντά της (<10m): αν μείνεις ακίνητος επιβραδύνει, αν τρέξεις επιταχύνει. Counter: πάγωσε στη θέση σου σε hunt."},
 {name:"Gallu", ev:["EMF","UV","SB"], hunt:"50% (νωρίτερα όταν enraged)", thMax:50, tell:"Crucifix, incense και salt το ΕΞΑΓΡΙΩΝΟΥΝ → πιο γρήγορο στο επόμενο hunt, μετά «εξαντλείται» και τα defensive items πιάνουν καλύτερα. Enraged δεν πατάει salt (μην το μπερδέψεις με Wraith — το Gallu πάτησε το πρώτο pile)."},
 {name:"Obambo", ev:["WRT","UV","DOTS"], hunt:"10% calm / 65% aggressive", thMax:65, tell:"Δύο «διαθέσεις» που εναλλάσσονται κάθε 2 λεπτά: calm = αργό και ακίνδυνο, aggressive = hunt από 65% sanity, πιο γρήγορο, αλλά 20% πιο σύντομο hunt. Ghost με mood swings = Obambo."},
 {name:"Aswang", ev:["DOTS","FRZ","WRT"], hunt:"50%", thMax:50, tell:"Επιταχύνει ΠΟΛΥ γρήγορα με line-of-sight (max speed σε ~9s αντί 13s) και προτιμά να κυνηγά παρά να ψάχνει. Unique: αν σε φτάσει σε ΕΠΙΣΗΜΟ hiding spot (locker/closet), το hunt τελειώνει αμέσως — αλλά στο επόμενο πάει κατευθείαν εκεί. Άλλαξε κρυψώνα!"},
 {name:"Kormos", ev:["ORB","SB","UV"], hunt:"50% / 70% αν τρέχεις κοντά του", thMax:70, tell:"ΤΥΦΛΟ — σε εντοπίζει από ήχους βημάτων. Counter: σε hunt μείνε τελείως ΑΚΙΝΗΤΟΣ (δεν χρειάζεσαι locker). Προσοχή: σκοτώνει σε 1.5m ακόμα και μέσα από τοίχους/έπιπλα, οπότε όχι ακίνητος δίπλα στο path του. Sprint = θάνατος."},
];
// Αγγλικές μεταφράσεις για tells & hunt strings (ό,τι λείπει πέφτει πίσω στα ελληνικά).
const TELL_EN = {
 "Spirit":"No obvious tell — the 'boring' ghost. Test: after incense/smudge it won't hunt for 180s (instead of 90s). If you count 2-3 quiet minutes after smudging → Spirit.",
 "Wraith":"NEVER steps in salt — no footprints, ever. Drop salt in a doorway: if everything else shows activity but the salt stays untouched, big Wraith hint.",
 "Phantom":"Photograph it during a ghost event: if it does NOT appear in the photo → Phantom. Stays invisible longer during hunts (sparse flickering). Don't look at it — it drains your sanity.",
 "Poltergeist":"Throws many objects at once, and often. Leave a pile of small items in one room — if it launches them all together (big sanity drain), Poltergeist.",
 "Banshee":"Targets ONE player (solo: you). Distinctive scream on the Parabolic Microphone (~1/3 of its sounds). 'Visits' its target instead of roaming randomly.",
 "Jinn":"With the breaker ON: fast from afar, normal up close. NEVER turns the breaker off itself. Its ability gives EMF at the breaker. Counter: turn the breaker off yourself and it goes back to normal.",
 "Mare":"Turns lights off the moment you switch them on, NEVER turns one on. Counter: keep the ghost room lit and it 'locks' at the 40% threshold — much safer.",
 "Revenant":"Two speeds: snail (1.0 m/s) when it can't see you, monster (3.0 m/s) when it can. Counter: hide IMMEDIATELY — once it loses your trail it crawls.",
 "Shade":"Shy: minimal activity while you're nearby, and it won't hunt if you're in the same room. If the house is 'dead' but there's a ghost, think Shade.",
 "Demon":"A hunt at full sanity = almost certainly Demon. Shortest cooldown between hunts (20s instead of 25s). Counter: crucifix — it has a bigger range on Demons.",
 "Yurei":"Slams doors FULLY shut with force (an ability that drains sanity). Counter: smudge INSIDE its room and it's pinned there for 90s — no roaming.",
 "Oni":"Hyperactive when you're close, throws objects hard. NEVER does the 'airball' event. More clearly visible during hunts (less flickering).",
 "Yokai":"Your voice enrages it — if hunts start while you're talking, suspicious. Counter: during a hunt it only hears/detects you within ~2.5m. Hide, shut up, and you're nearly untouchable.",
 "Hantu":"Faster the colder the room. Turns the breaker off, NEVER on. In a hunt with the breaker off it shows freezing breath (100% confirm). Counter: keep the house warm.",
 "Goryo":"D.O.T.S. shows ONLY through a video camera, and only when nobody is in the room. Almost never wanders far from its ghost room.",
 "Myling":"During hunts its footsteps/voice are audible only from very close — a 'silent killer'. More frequent paranormal sounds on the Parabolic. Heartbeat with no warning it was coming → Myling.",
 "Onryo":"Your last run's killer! Blows out flames — every 3rd extinguished flame = hunt, regardless of sanity. Counter: a lit candle/firelight next to it works like a crucifix (until it blows it out).",
 "The Twins":"Interactions in TWO different spots almost simultaneously (the 'twin' interacts from a distance). Hunts at two slightly different speeds.",
 "Raiju":"Fast near ACTIVE equipment and hunts earlier next to it. Interferes with electronics from a longer range. Counter: turn off/collect your gear from the ghost room.",
 "Obake":"Fingerprints with 6 fingers or weird shapes = instant confirm. Its prints fade in half the time. Briefly shapeshifts during hunts.",
 "The Mimic":"ALWAYS shows fake Ghost Orbs as a 4th evidence. Changes behavior every few minutes (Revenant one moment, Shade the next…). If the ghost 'changes personality', Mimic.",
 "Moroi":"Curses you through the Spirit Box or Parabolic → your sanity drains faster afterwards. Gets faster as your sanity drops. Counter: sanity pills clear the curse, smudge blinds it for longer.",
 "Deogen":"Heavy, wheezing breath on the Spirit Box from up close (unique). It ALWAYS finds you in hunts — don't hide! Counter: it gets very slow up close, loop around furniture.",
 "Thaye":"It 'ages': starts hyperactive, fast and aggressive, and as time passes (with you nearby) becomes slow and quiet. If the ghost 'got tired' → Thaye.",
 "Dayan":"ALWAYS a female name & model (like the Banshee). Near it (<10m): stand still and it slows down, run and it speeds up. Counter: freeze in place during hunts.",
 "Gallu":"Crucifix, incense and salt ENRAGE it → faster on the next hunt, then it 'exhausts' and defensive items work better. Enraged it won't step in salt (don't confuse with Wraith — the Gallu stepped in the first pile).",
 "Obambo":"Two 'moods' alternating every 2 minutes: calm = slow and harmless, aggressive = hunts from 65% sanity, faster, but 20% shorter hunts. A ghost with mood swings = Obambo.",
 "Aswang":"Accelerates VERY fast with line-of-sight (max speed in ~9s instead of 13s) and prefers chasing over searching. Unique: if it reaches you in an OFFICIAL hiding spot (locker/closet), the hunt ends instantly — but next hunt it goes straight there. Change spots!",
 "Kormos":"BLIND — it tracks you by footstep sounds. Counter: stand COMPLETELY still during hunts (no locker needed). Careful: it kills within 1.5m even through walls/furniture, so don't freeze next to its path. Sprinting = death.",
};
const HUNT_EN = {
 "Banshee":"50% of its target",
 "Mare":"60% dark / 40% light",
 "Demon":"70% + hunts at ANY sanity (ability)",
 "Yokai":"50% / 80% if you talk near it",
 "Raiju":"65% near electronics",
 "The Mimic":"mimics others",
 "Thaye":"75% fresh → 15% aged",
 "Dayan":"45% still / 60% moving",
 "Gallu":"50% (earlier when enraged)",
 "Kormos":"50% / 70% if you sprint near it",
};

function effEv(g){ return g.mimic ? [...g.ev,"ORB"] : g.ev; }

// Κανόνες συμπεριφοράς (χωρίς UI labels — αυτά μένουν per-page): ίδια 13 ids με το
// BEHAVIORS array του index.html και τα αντίστοιχα ids στο questionnaire.html.
const BEHAVIOR_RULES = [
 {id:"salt",       exclude:["Wraith"]},
 {id:"lightOn",    exclude:["Mare"]},
 {id:"breakerOn",  exclude:["Hantu"]},
 {id:"breakerOff", exclude:["Jinn"]},
 {id:"earlyHunt",  include:["Demon","Yokai","Thaye","Onryo","The Mimic"]},
 {id:"noPhoto",    include:["Phantom","The Mimic"]},
 {id:"foundHide",  include:["Deogen","Aswang","The Mimic"]},
 {id:"male",       exclude:["Banshee","Dayan"]},
 {id:"airball",    exclude:["Oni"]},
 {id:"sbBreath",   include:["Deogen"]},
 {id:"sixFinger",  include:["Obake"]},
 {id:"twinTouch",  include:["The Twins","The Mimic"]},
 {id:"doorSlam",   include:["Yurei","The Mimic"]},
];
