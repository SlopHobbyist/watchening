/*
 * Channel lineup + program pools for the guide.
 *
 * Each channel:
 *   n       channel number
 *   call    call letters shown in the guide
 *   hd      true for HD channels
 *   stream  (optional) URL of a live stream for the IPTV player (HLS/MP4/etc.)
 *   fixed   (optional) { "HH:MM": show }  — shows that always air at that time
 *   pool    shows that are randomly scheduled around the fixed ones
 *
 * Show tuple: [title, minutes, rating, description, flags, extra]
 *   flags:  m = movie, s = sports, k = kids, n = news
 *           D = daytime only (6a-5p), P = primetime/evening (5p-midnight), L = late night (midnight-6a)
 *           N = often a "New" episode
 *   extra:  for movies { y: year, st: stars (0-4, .5 steps), cast: "A, B" }
 *           for series [ "Episode Title", ... ]   (optional)
 */
(function () {
  const PAID = ["Paid Programming", 30, "", "Paid programming.", "L"];

  const locals = (net) => {
    const N = {
      CBS: {
        am: ["The Early Show", 120, "", "News, interviews and features.", "n"],
        day: [
          ["The Price Is Right", 60, "TV-G", "Contestants bid on prizes and play pricing games.", "D"],
          ["The Young and the Restless", 60, "TV-14", "Victor faces a crisis; Nikki confronts Jack.", "D"],
          ["The Bold and the Beautiful", 30, "TV-PG", "Ridge and Brooke clash over Forrester Creations.", "D"],
          ["As the World Turns", 60, "TV-14", "Residents of Oakdale face romance and intrigue.", "D"],
          ["Let's Make a Deal", 60, "TV-G", "Costumed contestants trade for prizes.", "D"],
        ],
        nightly: ["CBS Evening News With Katie Couric", 30, "", "National and international news.", "n"],
        late: ["Late Show With David Letterman", 62, "TV-PG", "Celebrity guests; Top Ten list; musical performance.", "N"],
        late2: ["The Late Late Show With Craig Ferguson", 60, "TV-14", "Celebrity guests and comedy.", "N"],
        prime: [
          ["NCIS", 60, "TV-PG", "The team investigates the death of a Navy petty officer found in a parking garage.", "PN", ["Masquerade", "Toxic", "Heartland", "Code of Conduct", "Broken Arrow"]],
          ["CSI: Crime Scene Investigation", 60, "TV-14", "The team investigates a murder at a Las Vegas casino.", "PN", ["Dead Air", "Coup de Grace", "Bloodlines", "Turn of the Screws"]],
          ["The Big Bang Theory", 30, "TV-PG", "Sheldon and Leonard try to impress Penny.", "PN", ["The Bad Fish Paradigm", "The Pancake Batter Anomaly", "The Barbarian Sublimation"]],
          ["Two and a Half Men", 30, "TV-14", "Charlie's latest romance complicates things for Alan.", "PN", ["Laxative Tester, Horse Inseminator", "Pie Hole, Herb", "Ixnay on the Oggie"]],
          ["How I Met Your Mother", 30, "TV-PG", "Ted recounts the story of how he met the kids' mother.", "PN", ["The Platinum Rule", "Robin 101", "Swarley"]],
          ["Criminal Minds", 60, "TV-14", "The BAU tracks a serial killer in the Pacific Northwest.", "PN", ["Mosley Lane", "The Uncanny Valley", "Profiler, Profiled"]],
          ["The Mentalist", 60, "TV-14", "Jane uses his observation skills to solve a murder.", "PN", ["Red John's Footsteps", "Russet Potatoes", "Redline"]],
          ["Survivor", 60, "TV-PG", "Castaways compete in a challenge for immunity.", "PN"],
          ["The Good Wife", 60, "TV-14", "Alicia takes on a high-profile case.", "PN"],
          ["Cold Case", 60, "TV-14", "Lilly reopens a decades-old murder investigation.", "P"],
        ],
      },
      ABC: {
        am: ["Good Morning America", 120, "", "News, interviews and features.", "n"],
        day: [
          ["The View", 60, "TV-14", "Hot topics; guest interviews.", "D"],
          ["All My Children", 60, "TV-14", "Erica makes a startling discovery.", "D"],
          ["One Life to Live", 60, "TV-14", "Llanview residents deal with love and betrayal.", "D"],
          ["General Hospital", 60, "TV-14", "Sonny makes a dangerous decision.", "D"],
          ["Live With Regis and Kelly", 60, "TV-PG", "Celebrity guests and host chat.", "D"],
        ],
        nightly: ["ABC World News With Charles Gibson", 30, "", "National and international news.", "n"],
        late: ["Nightline", 30, "", "In-depth news coverage.", "n"],
        late2: ["Jimmy Kimmel Live", 62, "TV-14", "Celebrity guests; musical performance.", "N"],
        prime: [
          ["Lost", 60, "TV-14", "The survivors struggle to get off the island.", "PN", ["The Constant", "Ji Yeon", "Cabin Fever", "Through the Looking Glass"]],
          ["Grey's Anatomy", 60, "TV-14", "Meredith and Derek face a difficult decision.", "PN", ["Here Comes the Flood", "Sweet Surrender", "Freedom"]],
          ["Desperate Housewives", 60, "TV-PG", "Gabrielle and Carlos face a surprising development.", "PN"],
          ["Dancing With the Stars", 60, "TV-PG", "The couples perform; one is eliminated.", "PN"],
          ["Ugly Betty", 60, "TV-PG", "Betty tries to impress Wilhelmina.", "PN"],
          ["Brothers & Sisters", 60, "TV-PG", "The Walker family deals with a crisis.", "PN"],
          ["Extreme Makeover: Home Edition", 60, "TV-PG", "The team builds a new home for a deserving family.", "P"],
          ["America's Funniest Home Videos", 60, "TV-PG", "Humorous home videos.", "P"],
          ["Castle", 60, "TV-PG", "Castle and Beckett investigate a high-society murder.", "PN"],
          ["Modern Family", 30, "TV-PG", "Phil tries to bond with Luke.", "PN"],
        ],
      },
      NBC: {
        am: ["Today", 120, "", "News, weather, interviews and features.", "n"],
        day: [
          ["Days of Our Lives", 60, "TV-14", "Bo and Hope face a new threat.", "D"],
          ["Ellen: The Ellen DeGeneres Show", 60, "TV-G", "Celebrity guests; audience games.", "D"],
          ["Today", 60, "", "Kathie Lee and Hoda.", "D"],
          ["Access Hollywood", 30, "TV-PG", "Entertainment news.", "D"],
        ],
        nightly: ["NBC Nightly News With Brian Williams", 30, "", "National and international news.", "n"],
        late: ["The Tonight Show With Jay Leno", 62, "TV-PG", "Celebrity guests; comedy; musical performance.", "N"],
        late2: ["Late Night With Conan O'Brien", 60, "TV-14", "Celebrity guests and comedy.", "N"],
        prime: [
          ["The Office", 30, "TV-PG", "Michael tries to boost morale at Dunder Mifflin.", "PN", ["Dinner Party", "Stress Relief", "Niagara", "Scott's Tots"]],
          ["30 Rock", 30, "TV-14", "Liz and Jack clash over a new show idea.", "PN"],
          ["Heroes", 60, "TV-14", "Hiro and Ando travel to the future.", "PN", ["Villains", "The Second Coming", "Volume Four: Fugitives"]],
          ["Law & Order: Special Victims Unit", 60, "TV-14", "Benson and Stabler investigate an assault.", "PN"],
          ["Law & Order", 60, "TV-14", "Detectives investigate a murder; prosecutors argue the case.", "P"],
          ["ER", 60, "TV-14", "The staff treats victims of a multicar accident.", "PN"],
          ["Deal or No Deal", 60, "TV-PG", "A contestant chooses briefcases for a chance at $1 million.", "P"],
          ["Chuck", 60, "TV-PG", "Chuck goes undercover at a high school reunion.", "PN"],
          ["Friday Night Lights", 60, "TV-PG", "The Panthers prepare for a big game.", "PN"],
          ["My Name Is Earl", 30, "TV-14", "Earl tries to make amends.", "PN"],
        ],
      },
      FOX: {
        am: ["Good Day Philadelphia", 120, "", "Local news, weather and features.", "n"],
        day: [
          ["Judge Alex", 30, "TV-PG", "Real cases, real people.", "D"],
          ["The People's Court", 60, "TV-PG", "Judge Marilyn Milian presides over real cases.", "D"],
          ["Maury", 60, "TV-14", "Paternity tests and family conflicts.", "D"],
          ["Dr. Phil", 60, "TV-PG", "Dr. Phil helps a family in crisis.", "D"],
          ["Judge Judy", 30, "TV-PG", "Real cases, real people.", "D"],
        ],
        nightly: ["Seinfeld", 30, "TV-PG", "Jerry and George try to get out of a dinner party.", "", ["The Soup Nazi", "The Contest", "The Marine Biologist", "The Parking Garage"]],
        late: ["MADtv", 60, "TV-14", "Sketch comedy.", ""],
        late2: ["King of the Hill", 30, "TV-PG", "Hank tries to teach Bobby the value of hard work.", ""],
        prime: [
          ["American Idol", 60, "TV-PG", "The finalists perform live.", "PN"],
          ["House", 60, "TV-14", "House and the team treat a patient with mysterious symptoms.", "PN", ["Wilson's Heart", "Last Resort", "Broken"]],
          ["24", 60, "TV-14", "Jack races to stop a terrorist attack.", "PN"],
          ["The Simpsons", 30, "TV-PG", "Homer takes up a new hobby.", "PN"],
          ["Family Guy", 30, "TV-14", "Peter starts a feud with a giant chicken.", "PN"],
          ["Bones", 60, "TV-14", "Brennan and Booth investigate remains found in a park.", "PN"],
          ["Fringe", 60, "TV-14", "Olivia investigates a bizarre occurrence.", "PN"],
          ["Prison Break", 60, "TV-14", "Michael plans another escape.", "PN"],
          ["Hell's Kitchen", 60, "TV-14", "Chef Ramsay challenges the contestants.", "PN"],
          ["Cops", 30, "TV-14", "Police officers in action.", "P"],
        ],
      },
    }[net];
    const tag = { CBS: "Eyewitness News", ABC: "Action News", NBC: "NBC 10 News", FOX: "Fox 29 News" }[net];
    const fixed = {
      "05:00": [tag + " This Morning", 120, "", "Local news, weather and traffic.", "n"],
      "07:00": N.am,
      "12:00": [tag + " at Noon", 30, "", "Local news and weather.", "n"],
      "17:00": [tag, 60, "", "Local news, weather and sports.", "n"],
      "18:00": [tag + " at 6", 30, "", "Local news, weather and sports.", "n"],
      "18:30": N.nightly,
      "19:00": net === "FOX" ? N.nightly : ["Entertainment Tonight", 30, "TV-PG", "Celebrity news and interviews.", ""],
      "19:30": net === "FOX" ? ["Two and a Half Men", 30, "TV-14", "Charlie dates a woman with a secret.", ""] : ["Jeopardy!", 30, "TV-G", "Contestants answer trivia questions.", ""],
      "23:00": net === "FOX" ? ["Fox 29 News at 10", 60, "", "Local news, weather and sports.", "n"] : [tag + " at 11", 35, "", "Local news, weather and sports.", "n"],
    };
    if (net === "FOX") {
      fixed["22:00"] = ["Fox 29 News at 10", 60, "", "Local news, weather and sports.", "n"];
      fixed["23:00"] = ["Seinfeld", 30, "TV-PG", "Elaine's new boyfriend is a puzzle.", ""];
      fixed["23:30"] = N.late2;
      fixed["00:00"] = N.late;
    } else {
      fixed["23:35"] = N.late;
      fixed[net === "ABC" ? "00:05" : "00:37"] = N.late2;
    }
    return { fixed, pool: [...N.day, ...N.prime, PAID, PAID] };
  };

  const hourly = (list) => {
    const f = {};
    for (let h = 0; h < 24; h++) f[String(h).padStart(2, "0") + ":00"] = list[(h + 4) % 24 % list.length]; // list[0] airs at 8pm
    return f;
  };

  const LINEUP = [
    { n: 3, call: "KYW", ...locals("CBS") },
    { n: 6, call: "WPVI", ...locals("ABC") },
    { n: 10, call: "WCAU", ...locals("NBC") },
    {
      n: 12, call: "WHYY",
      fixed: { "18:00": ["Nightly Business Report", 30, "", "Business and financial news.", "n"], "18:30": ["The NewsHour With Jim Lehrer", 60, "", "In-depth news analysis.", "n"] },
      pool: [
        ["NOVA", 60, "TV-PG", "Scientists investigate the origins of the universe.", "P"],
        ["Antiques Roadshow", 60, "TV-G", "Appraisals of treasures in Tampa, Fla.", "P"],
        ["Frontline", 60, "TV-PG", "An investigation into the U.S. economy.", "P"],
        ["Nature", 60, "TV-G", "The secret lives of wolves in Yellowstone.", "P"],
        ["Masterpiece Classic", 90, "TV-PG", "Jane Austen's \"Sense and Sensibility.\"", "P"],
        ["Sesame Street", 60, "TV-Y", "Elmo learns about sharing.", "kD"],
        ["Clifford the Big Red Dog", 30, "TV-Y", "Clifford and friends visit the beach.", "kD"],
        ["Arthur", 30, "TV-Y7", "Arthur and D.W. go to the library.", "kD"],
        ["This Old House", 30, "TV-G", "Renovating a Victorian home.", ""],
        ["Charlie Rose", 60, "", "Interviews with newsmakers.", "L"],
      ],
    },
    {
      n: 17, call: "WPHL",
      fixed: { "22:00": ["PHL17 News at 10", 60, "", "Local news, weather and sports.", "n"] },
      pool: [
        ["The King of Queens", 30, "TV-PG", "Doug hides a purchase from Carrie.", ""],
        ["Everybody Loves Raymond", 30, "TV-PG", "Marie meddles in Ray and Debra's marriage.", ""],
        ["Family Feud", 30, "TV-PG", "Two families compete.", ""],
        ["Friends", 30, "TV-PG", "Ross and Rachel try to work things out.", ""],
        ["The Steve Wilkos Show", 60, "TV-14", "Guests confront family members.", "D"],
        ["Smallville", 60, "TV-PG", "Clark faces a new enemy.", "P"],
        ["WWE Friday Night SmackDown", 120, "TV-PG", "Professional wrestling.", "sP"],
      ],
    },
    {
      n: 23, call: "WGN",
      pool: [
        ["America's Funniest Home Videos", 30, "TV-PG", "Humorous home videos.", ""],
        ["Becker", 30, "TV-PG", "Becker deals with a difficult patient.", ""],
        ["Scrubs", 30, "TV-14", "J.D. tries to impress Dr. Cox.", ""],
        ["Major League Baseball", 180, "", "Chicago Cubs at St. Louis Cardinals.", "sP"],
        ["Bulls Basketball", 150, "", "Chicago Bulls at Detroit Pistons.", "sP"],
        ["Walker, Texas Ranger", 60, "TV-PG", "Walker goes undercover.", "D"],
        ["In the Heat of the Night", 60, "TV-PG", "Gillespie investigates a murder.", "D"],
      ],
    },
    {
      n: 24, call: "TBS",
      pool: [
        ["Seinfeld", 30, "TV-PG", "George pretends to be a marine biologist.", "", ["The Marine Biologist", "The Soup Nazi", "The Puffy Shirt", "The Opposite"]],
        ["Family Guy", 30, "TV-14", "Stewie and Brian go on a road trip.", ""],
        ["The Office", 30, "TV-PG", "Michael plans a dinner party.", ""],
        ["Friends", 30, "TV-PG", "Joey gets a new roommate.", ""],
        ["Everybody Loves Raymond", 30, "TV-PG", "Ray forgets his anniversary.", ""],
        ["Tyler Perry's House of Payne", 30, "TV-PG", "Curtis gets a new job.", "N"],
        ["My Name Is Earl", 30, "TV-14", "Earl tries to cross another item off his list.", ""],
        ["Wedding Crashers", 150, "R", "Two divorce mediators crash weddings to meet women.", "m", { y: 2005, st: 3, cast: "Owen Wilson, Vince Vaughn" }],
        ["Meet the Parents", 120, "PG-13", "A man meets his girlfriend's suspicious father.", "m", { y: 2000, st: 3, cast: "Robert De Niro, Ben Stiller" }],
      ],
    },
    {
      n: 25, call: "USA",
      pool: [
        ["Law & Order: Special Victims Unit", 60, "TV-14", "Benson and Stabler investigate a rape case.", ""],
        ["Law & Order: Criminal Intent", 60, "TV-14", "Goren and Eames investigate a socialite's death.", ""],
        ["Monk", 60, "TV-PG", "Monk investigates a murder at a circus.", "N"],
        ["Psych", 60, "TV-PG", "Shawn and Gus investigate a haunted house.", "N"],
        ["Burn Notice", 60, "TV-PG", "Michael helps a client while searching for answers.", "N"],
        ["NCIS", 60, "TV-PG", "Gibbs and the team investigate a sailor's death.", ""],
        ["House", 60, "TV-14", "House treats a patient with paralysis.", ""],
        ["WWE Monday Night Raw", 120, "TV-PG", "Professional wrestling.", "sP"],
        ["Patch Adams", 150, "PG-13", "A medical student uses humor to treat patients.", "m", { y: 1998, st: 2, cast: "Robin Williams, Daniel London" }],
      ],
    },
    {
      n: 26, call: "TNT",
      pool: [
        ["Law & Order", 60, "TV-14", "Detectives investigate a murder; prosecutors argue the case.", ""],
        ["Bones", 60, "TV-14", "Remains are found in a landfill.", ""],
        ["Cold Case", 60, "TV-14", "Lilly reopens a 1960s case.", ""],
        ["The Closer", 60, "TV-14", "Brenda investigates the death of a witness.", "PN"],
        ["Saving Grace", 60, "TV-MA", "Grace investigates a church fire.", "PN"],
        ["Las Vegas", 60, "TV-PG", "Danny deals with a high roller.", "D"],
        ["NBA Basketball", 150, "", "Boston Celtics at Los Angeles Lakers.", "sP"],
        ["The Shawshank Redemption", 180, "R", "An innocent man forms a friendship in prison.", "m", { y: 1994, st: 4, cast: "Tim Robbins, Morgan Freeman" }],
      ],
    },
    {
      n: 27, call: "ESPN", hd: true,
      fixed: { "18:00": ["SportsCenter", 60, "", "The latest sports news and highlights.", "s"], "23:00": ["SportsCenter", 60, "", "The latest sports news and highlights.", "s"], "00:00": ["SportsCenter", 60, "", "The latest sports news and highlights.", "s"] },
      pool: [
        ["SportsCenter", 60, "", "The latest sports news and highlights.", "s"],
        ["NBA Basketball", 150, "", "Detroit Pistons at Chicago Bulls.", "sP"],
        ["College Football", 210, "", "Ohio State at Michigan.", "sP"],
        ["NFL Live", 30, "", "News and analysis.", "s"],
        ["Pardon the Interruption", 30, "", "Sports debate.", "s"],
        ["Around the Horn", 30, "", "Sportswriters debate.", "s"],
        ["Mike and Mike in the Morning", 60, "", "Sports talk.", "sD"],
        ["Monday Night Football", 210, "", "Green Bay Packers at Minnesota Vikings.", "sP"],
      ],
    },
    {
      n: 28, call: "ESPN2",
      pool: [
        ["First Take", 60, "", "Sports talk and debate.", "sD"],
        ["Totally NASCAR", 30, "", "NASCAR news and features.", "s"],
        ["SportsCenter", 60, "", "The latest sports news and highlights.", "s"],
        ["College Basketball", 120, "", "Duke at North Carolina.", "s"],
        ["Tennis", 120, "", "U.S. Open, men's quarterfinal.", "s"],
        ["NHRA Drag Racing", 120, "", "From Pomona, Calif.", "s"],
        ["Outside the Lines", 30, "", "Investigative sports journalism.", "s"],
        ["Bassmasters", 60, "", "Fishing competition.", "s"],
      ],
    },
    { n: 29, call: "WTXF", ...locals("FOX") },
    {
      n: 30, call: "A&E",
      pool: [
        ["Biography", 60, "TV-PG", "\"Dwight D. Eisenhower\", (2004), As Supreme Allied Commander, Eisenhower led the Allied invasion of Europe.", ""],
        ["Cold Case Files", 60, "TV-14", "Detectives reopen a case from 1982.", ""],
        ["CSI: Miami", 60, "TV-14", "Horatio investigates a boat explosion.", ""],
        ["The First 48", 60, "TV-14", "Detectives race the clock on a homicide.", "P"],
        ["Dog the Bounty Hunter", 30, "TV-PG", "Dog and his team track a fugitive.", ""],
        ["Criminal Minds", 60, "TV-14", "The team profiles a serial arsonist.", ""],
        ["Intervention", 60, "TV-14", "An addict's family stages an intervention.", "P"],
        ["Gene Simmons Family Jewels", 30, "TV-PG", "Gene plans a family vacation.", "P"],
      ],
    },
    {
      n: 31, call: "HIST",
      pool: [
        ["Modern Marvels", 60, "TV-G", "The engineering behind skyscrapers.", ""],
        ["MonsterQuest", 60, "TV-PG", "Investigating sightings of Bigfoot.", ""],
        ["Ice Road Truckers", 60, "TV-PG", "Drivers haul loads over frozen lakes.", "P"],
        ["Ax Men", 60, "TV-PG", "Loggers battle the elements in Oregon.", "P"],
        ["UFO Hunters", 60, "TV-PG", "Investigating a mass sighting.", ""],
        ["The Universe", 60, "TV-PG", "Exploring black holes.", ""],
        ["Dogfights", 60, "TV-PG", "Recreating historic air battles.", ""],
        ["Cities of the Underworld", 60, "TV-PG", "Exploring tunnels beneath Paris.", ""],
      ],
    },
    {
      n: 32, call: "DISC", hd: true,
      pool: [
        ["MythBusters", 60, "TV-PG", "Adam and Jamie test movie myths.", "N"],
        ["Dirty Jobs", 60, "TV-PG", "Mike works as a sewer inspector.", ""],
        ["Deadliest Catch", 60, "TV-14", "The crews face a brutal storm in the Bering Sea.", "PN"],
        ["Man vs. Wild", 60, "TV-PG", "Bear Grylls survives in the Sahara.", ""],
        ["American Chopper", 60, "TV-PG", "The Teutuls build a bike for a client.", ""],
        ["Cash Cab", 30, "TV-G", "Passengers answer trivia questions.", ""],
        ["How It's Made", 30, "TV-G", "Bowling balls; pianos; car mufflers.", ""],
        ["Planet Earth", 60, "TV-G", "Life in the deserts of the world.", ""],
      ],
    },
    {
      n: 33, call: "TLC",
      pool: [
        ["Jon & Kate Plus 8", 30, "TV-PG", "The family takes a trip.", ""],
        ["What Not to Wear", 60, "TV-PG", "Stacy and Clinton make over a teacher.", ""],
        ["Say Yes to the Dress", 30, "TV-PG", "Brides shop for wedding gowns.", ""],
        ["Little People, Big World", 30, "TV-PG", "The Roloffs prepare for pumpkin season.", ""],
        ["Cake Boss", 30, "TV-PG", "Buddy creates a giant cake.", "P"],
        ["A Baby Story", 30, "TV-PG", "A couple welcomes their first child.", "D"],
        ["Trading Spaces", 60, "TV-G", "Neighbors redecorate each other's rooms.", ""],
      ],
    },
    {
      n: 34, call: "HGTV",
      pool: [
        ["Decorating Cents", 30, "TV-G", "Decorating on a budget.", ""],
        ["Divine Design", 30, "TV-G", "Candice Olson redesigns a living room.", ""],
        ["Home to Go", 30, "TV-G", "Decorating ideas.", ""],
        ["House Hunters", 30, "TV-G", "A couple searches for a home in Atlanta.", ""],
        ["Design on a Dime", 30, "TV-G", "A room makeover for $1,000.", ""],
        ["Curb Appeal", 30, "TV-G", "A home's exterior gets a makeover.", ""],
        ["Property Virgins", 30, "TV-G", "First-time buyers search for a home.", ""],
        ["Holmes on Homes", 60, "TV-G", "Mike fixes a botched renovation.", ""],
      ],
    },
    {
      n: 35, call: "FOOD",
      pool: [
        ["30 Minute Meals", 30, "TV-G", "Rachael Ray makes a quick dinner.", "D"],
        ["Barefoot Contessa", 30, "TV-G", "Ina Garten prepares a dinner party.", "D"],
        ["Iron Chef America", 60, "TV-G", "Battle: Scallops.", "P"],
        ["Diners, Drive-Ins and Dives", 30, "TV-G", "Guy Fieri visits classic diners.", ""],
        ["Unwrapped", 30, "TV-G", "How favorite snacks are made.", ""],
        ["Good Eats", 30, "TV-G", "Alton Brown explores the science of cooking.", ""],
        ["Ace of Cakes", 30, "TV-G", "Duff and crew make a cake.", "P"],
        ["Paula's Home Cooking", 30, "TV-G", "Southern comfort food.", "D"],
      ],
    },
    {
      n: 36, call: "NICK",
      pool: [
        ["SpongeBob SquarePants", 30, "TV-Y7", "SpongeBob and Patrick go jellyfishing.", "k"],
        ["Fairly OddParents", 30, "TV-Y7", "Timmy wishes for a new life.", "k"],
        ["Drake & Josh", 30, "TV-G", "Drake and Josh compete for a job.", "k"],
        ["iCarly", 30, "TV-G", "Carly, Sam and Freddie plan a webcast.", "kN"],
        ["The Backyardigans", 30, "TV-Y", "The friends go on an adventure.", "kD"],
        ["Dora the Explorer", 30, "TV-Y", "Dora and Boots help a friend.", "kD"],
        ["Jimmy Neutron", 30, "TV-Y7", "Jimmy's invention goes haywire.", "k"],
        ["George Lopez", 30, "TV-PG", "George deals with his mother.", "L"],
        ["Fresh Prince of Bel-Air", 30, "TV-PG", "Will tries to impress a girl.", "L"],
      ],
    },
    {
      n: 37, call: "TOON",
      pool: [
        ["Ben 10: Alien Force", 30, "TV-Y7", "Ben faces off against the Highbreed.", "kDP"],
        ["Chowder", 30, "TV-Y7", "Chowder causes trouble in the kitchen.", "kDP"],
        ["Foster's Home for Imaginary Friends", 30, "TV-Y7", "Bloo gets into trouble.", "kDP"],
        ["Total Drama Island", 30, "TV-PG", "Campers face a challenge.", "kP"],
        ["Courage the Cowardly Dog", 30, "TV-Y7", "Courage protects his owners.", "kD"],
        ["King of the Hill", 30, "TV-PG", "\"Grand Theft Arlen\", (TV-PG), Hank cannot stop playing a video game about propane; Bobby trains for a competition.", "L"],
        ["Family Guy", 30, "TV-14", "Peter becomes a lobbyist.", "L"],
        ["American Dad", 30, "TV-14", "Stan tries to get a promotion.", "L"],
        ["Robot Chicken", 30, "TV-14", "Stop-motion sketch comedy.", "L"],
        ["Aqua Teen Hunger Force", 30, "TV-14", "The Aqua Teens battle a new foe.", "L"],
      ],
    },
    {
      n: 38, call: "DSNY",
      pool: [
        ["Hannah Montana", 30, "TV-G", "Miley tries to keep her secret.", "k"],
        ["The Suite Life of Zack & Cody", 30, "TV-G", "The twins start a business.", "k"],
        ["Wizards of Waverly Place", 30, "TV-G", "Alex uses magic to cheat on a test.", "k"],
        ["Phineas and Ferb", 30, "TV-G", "The boys build a roller coaster.", "k"],
        ["That's So Raven", 30, "TV-G", "Raven has a vision.", "k"],
        ["Mickey Mouse Clubhouse", 30, "TV-Y", "Mickey and friends solve a problem.", "kD"],
        ["Handy Manny", 30, "TV-Y", "Manny and his tools help a neighbor.", "kD"],
        ["High School Musical 2", 120, "TV-G", "The Wildcats spend the summer at a country club.", "mkP", { y: 2007, st: 2.5, cast: "Zac Efron, Vanessa Hudgens" }],
      ],
    },
    {
      n: 39, call: "CNN",
      fixed: hourly([
        ["Larry King Live", 60, "", "Interviews with newsmakers.", "n"],
        ["Anderson Cooper 360", 60, "", "In-depth news coverage.", "n"],
        ["CNN Newsroom", 60, "", "Breaking news and analysis.", "n"],
        ["The Situation Room", 60, "", "Wolf Blitzer reports.", "n"],
        ["Lou Dobbs Tonight", 60, "", "Business and political news.", "n"],
        ["CNN Newsroom", 60, "", "Breaking news and analysis.", "n"],
        ["Campbell Brown: No Bias, No Bull", 60, "", "Political news.", "n"],
      ]),
      pool: [["CNN Newsroom", 60, "", "Breaking news and analysis.", "n"]],
    },
    {
      n: 40, call: "HLN",
      fixed: hourly([
        ["Headline News", 30, "", "News updates every 30 minutes.", "n"],
        ["Nancy Grace", 60, "", "Legal issues and crime.", "n"],
        ["Glenn Beck", 60, "", "Political commentary.", "n"],
        ["Showbiz Tonight", 60, "", "Entertainment news.", "n"],
        ["Prime News", 60, "", "News and analysis.", "n"],
      ]),
      pool: [["Headline News", 30, "", "News updates every 30 minutes.", "n"]],
    },
    {
      n: 41, call: "FNC",
      fixed: hourly([
        ["The O'Reilly Factor", 60, "", "Bill O'Reilly reports.", "n"],
        ["Hannity & Colmes", 60, "", "Political debate.", "n"],
        ["On the Record With Greta Van Susteren", 60, "", "News and legal analysis.", "n"],
        ["Fox Report With Shepard Smith", 60, "", "News of the day.", "n"],
        ["Special Report With Brit Hume", 60, "", "Political news.", "n"],
        ["America's Newsroom", 60, "", "Breaking news.", "n"],
      ]),
      pool: [["Fox News Live", 60, "", "Breaking news.", "n"]],
    },
    {
      n: 42, call: "MSNBC",
      fixed: hourly([
        ["Countdown With Keith Olbermann", 60, "", "News and commentary.", "n"],
        ["Hardball With Chris Matthews", 60, "", "Political news and debate.", "n"],
        ["The Rachel Maddow Show", 60, "", "News and commentary.", "n"],
        ["MSNBC Investigates", 60, "TV-14", "Lockup: Inside San Quentin.", ""],
        ["MSNBC Live", 60, "", "Breaking news.", "n"],
      ]),
      pool: [["MSNBC Live", 60, "", "Breaking news.", "n"]],
    },
    {
      n: 43, call: "CNBC",
      pool: [
        ["Mad Money", 60, "", "Jim Cramer gives stock advice.", "n"],
        ["Squawk Box", 60, "", "Business news.", "nD"],
        ["Closing Bell", 60, "", "Market coverage.", "nD"],
        ["The Big Idea With Donny Deutsch", 60, "", "Entrepreneurs share their stories.", "P"],
        ["American Greed", 60, "TV-PG", "Investigating white-collar crime.", "P"],
        ["Paid Programming", 30, "", "Paid programming.", "L"],
      ],
    },
    {
      n: 44, call: "WEATH",
      pool: [
        ["Weather Center", 60, "", "Weather forecasts and updates.", "n"],
        ["Abrams & Bettes: Beyond the Forecast", 60, "", "Weather news.", "n"],
        ["Storm Stories", 30, "TV-PG", "True stories of survival.", ""],
        ["It Could Happen Tomorrow", 30, "TV-PG", "Disaster scenarios.", ""],
        ["Day Planner", 60, "", "Weather forecasts.", "nD"],
      ],
    },
    {
      n: 45, call: "MTV",
      pool: [
        ["The Hills", 30, "TV-PG", "Lauren and Heidi's friendship is tested.", "PN"],
        ["Real World", 60, "TV-14", "Roommates clash in Brooklyn.", ""],
        ["Rob & Big", 30, "TV-14", "Rob and Big get a new pet.", ""],
        ["MTV Cribs", 30, "TV-PG", "Tours of celebrity homes.", ""],
        ["Pimp My Ride", 30, "TV-PG", "Xzibit gives a car a makeover.", ""],
        ["The Real World/Road Rules Challenge", 60, "TV-14", "Teams compete for cash.", "P"],
        ["AMTV", 180, "", "Music videos.", "L"],
      ],
    },
    {
      n: 46, call: "VH1",
      pool: [
        ["I Love the '80s", 60, "TV-14", "Pop culture of 1985.", ""],
        ["Behind the Music", 60, "TV-14", "The story of a band.", ""],
        ["Celebrity Rehab With Dr. Drew", 60, "TV-14", "Celebrities battle addiction.", "P"],
        ["Flavor of Love", 60, "TV-14", "Flavor Flav searches for love.", "P"],
        ["Best Week Ever", 30, "TV-14", "Pop culture recap.", ""],
        ["Top 20 Video Countdown", 120, "", "Music videos.", "D"],
      ],
    },
    {
      n: 47, call: "BET",
      pool: [
        ["106 & Park", 60, "TV-PG", "Music videos and celebrity guests.", "D"],
        ["The Game", 30, "TV-PG", "Melanie tries to fit in.", ""],
        ["Lockdown", 120, "R", "Three friends are wrongly convicted.", "m", { y: 2000, st: 1.5, cast: "Richard T. Jones, Gabriel Casseus" }],
        ["American Gangster", 60, "TV-14", "Profiles of notorious criminals.", "P"],
        ["The Wayans Bros.", 30, "TV-PG", "Shawn and Marlon start a business.", ""],
        ["Sister, Sister", 30, "TV-G", "Twins separated at birth.", "D"],
      ],
    },
    {
      n: 48, call: "SPIKE",
      pool: [
        ["CSI: Crime Scene Investigation", 60, "TV-14", "A murder at a casino.", ""],
        ["UFC Unleashed", 60, "TV-14", "Mixed martial arts.", "s"],
        ["1000 Ways to Die", 30, "TV-14", "Bizarre deaths.", ""],
        ["Ride With Funkmaster Flex", 30, "TV-PG", "\"Ashanti's Cotton Candy Machine\", New, (2004), Ashanti gets a custom ride.", ""],
        ["Deadliest Warrior", 60, "TV-14", "Pirate vs. knight.", "P"],
        ["Star Wars: Episode III - Revenge of the Sith", 180, "PG-13", "Anakin Skywalker falls to the dark side.", "m", { y: 2005, st: 3, cast: "Ewan McGregor, Hayden Christensen" }],
      ],
    },
    {
      n: 49, call: "COM",
      pool: [
        ["The Daily Show With Jon Stewart", 30, "TV-14", "News satire.", "PN"],
        ["The Colbert Report", 30, "TV-14", "Political satire.", "PN"],
        ["South Park", 30, "TV-MA", "The boys try to get famous on the Internet.", ""],
        ["Scrubs", 30, "TV-14", "J.D. and Turk plan a trip.", ""],
        ["Reno 911!", 30, "TV-14", "The deputies go undercover.", ""],
        ["Chappelle's Show", 30, "TV-MA", "Sketch comedy.", ""],
        ["Comedy Central Presents", 30, "TV-14", "Stand-up comedy.", ""],
        ["American Pie", 120, "R", "Four friends make a pact before graduation.", "m", { y: 1999, st: 2.5, cast: "Jason Biggs, Chris Klein" }],
      ],
    },
    {
      n: 50, call: "SYFY",
      pool: [
        ["Stargate SG-1", 60, "TV-PG", "The team travels to a new world.", ""],
        ["Battlestar Galactica", 60, "TV-14", "The fleet faces a Cylon attack.", "PN"],
        ["Ghost Hunters", 60, "TV-PG", "TAPS investigates a haunted prison.", "P"],
        ["Eureka", 60, "TV-PG", "Carter deals with a scientific mishap.", "PN"],
        ["Twilight Zone", 30, "TV-PG", "A man discovers a strange town.", ""],
        ["Sharktopus", 120, "TV-14", "A genetically engineered creature terrorizes a resort.", "m", { y: 2010, st: 1, cast: "Eric Roberts, Kerem Bursin" }],
      ],
    },
    {
      n: 51, call: "FX",
      pool: [
        ["That '70s Show", 30, "TV-PG", "Eric and Donna's relationship hits a snag.", ""],
        ["King of the Hill", 30, "TV-PG", "Hank enters a grilling contest.", ""],
        ["Two and a Half Men", 30, "TV-14", "Charlie's mother moves in.", ""],
        ["Rescue Me", 60, "TV-MA", "Tommy struggles with his demons.", "PN"],
        ["Nip/Tuck", 60, "TV-MA", "Sean and Christian face a lawsuit.", "PN"],
        ["It's Always Sunny in Philadelphia", 30, "TV-MA", "The gang tries to get rich.", "PN"],
        ["X-Men: The Last Stand", 150, "PG-13", "A cure for mutation divides the mutants.", "m", { y: 2006, st: 2.5, cast: "Hugh Jackman, Halle Berry" }],
      ],
    },
    {
      n: 52, call: "AMC",
      pool: [
        ["The Untouchables", 150, "R", "Eliot Ness leads a team against Al Capone.", "m", { y: 1987, st: 3.5, cast: "Kevin Costner, Sean Connery" }],
        ["Mad Men", 60, "TV-14", "Don pitches a new account.", "PN"],
        ["Breaking Bad", 60, "TV-14", "Walt and Jesse make a deal.", "PN"],
        ["Goldfinger", 150, "PG", "James Bond battles a gold smuggler.", "m", { y: 1964, st: 4, cast: "Sean Connery, Gert Frobe" }],
        ["Rocky II", 150, "PG", "Rocky gets a rematch with Apollo Creed.", "m", { y: 1979, st: 3, cast: "Sylvester Stallone, Talia Shire" }],
        ["The Godfather", 210, "R", "A crime family's patriarch transfers control to his son.", "m", { y: 1972, st: 4, cast: "Marlon Brando, Al Pacino" }],
      ],
    },
    {
      n: 53, call: "TCM",
      pool: [
        ["Rider from Tucson", 60, "NR", "Tim Holt and Richard Martin help a rancher.", "m", { y: 1950, st: 2, cast: "Tim Holt, Richard Martin" }],
        ["Casablanca", 120, "PG", "A nightclub owner meets his old flame in Morocco.", "m", { y: 1942, st: 4, cast: "Humphrey Bogart, Ingrid Bergman" }],
        ["The Philadelphia Story", 120, "NR", "A socialite's wedding plans are complicated.", "m", { y: 1940, st: 4, cast: "Cary Grant, Katharine Hepburn" }],
        ["North by Northwest", 150, "NR", "An ad man is mistaken for a spy.", "m", { y: 1959, st: 4, cast: "Cary Grant, Eva Marie Saint" }],
        ["Singin' in the Rain", 120, "G", "Hollywood moves to talking pictures.", "m", { y: 1952, st: 4, cast: "Gene Kelly, Debbie Reynolds" }],
        ["The Maltese Falcon", 120, "NR", "A detective searches for a priceless statue.", "m", { y: 1941, st: 4, cast: "Humphrey Bogart, Mary Astor" }],
      ],
    },
    {
      n: 54, call: "LIFE",
      pool: [
        ["Reba", 30, "TV-PG", "Reba helps Cheyenne.", ""],
        ["Frasier", 30, "TV-PG", "Frasier tries to impress a date.", ""],
        ["Golden Girls", 30, "TV-PG", "Blanche has a new beau.", ""],
        ["Project Runway", 90, "TV-PG", "Designers create evening wear.", "PN"],
        ["Army Wives", 60, "TV-PG", "The wives face new challenges.", "PN"],
        ["Will & Grace", 30, "TV-14", "Will and Grace argue.", ""],
        ["Her Deadly Rx", 120, "TV-14", "A pharmacist suspects foul play.", "m", { y: 2006, st: 2, cast: "Nicole Eggert, Andrew Airlie" }],
      ],
    },
    {
      n: 55, call: "BRVO",
      pool: [
        ["Top Chef", 60, "TV-14", "The chefs cook for a wedding.", "PN"],
        ["The Real Housewives of Orange County", 60, "TV-14", "Tensions flare at a party.", "P"],
        ["Inside the Actors Studio", 60, "TV-PG", "James Lipton interviews an actor.", ""],
        ["Queer Eye", 60, "TV-14", "The Fab Five make over a firefighter.", ""],
        ["Kathy Griffin: My Life on the D-List", 30, "TV-14", "Kathy goes on tour.", ""],
      ],
    },
    {
      n: 56, call: "E!",
      pool: [
        ["E! News", 60, "TV-PG", "Entertainment news.", "P"],
        ["The Soup", 30, "TV-14", "A satirical look at pop culture.", ""],
        ["Keeping Up With the Kardashians", 30, "TV-14", "Kim plans a party.", "P"],
        ["The Girls Next Door", 30, "TV-14", "The girls plan a trip.", ""],
        ["E! True Hollywood Story", 60, "TV-14", "A celebrity's rise and fall.", ""],
        ["Chelsea Lately", 30, "TV-14", "Comedy talk show.", "L"],
      ],
    },
    {
      n: 57, call: "WPSG",
      pool: [
        ["Gossip Girl", 60, "TV-14", "Serena and Blair clash.", "PN"],
        ["One Tree Hill", 60, "TV-14", "Lucas makes a decision.", "PN"],
        ["Smallville", 60, "TV-PG", "Clark faces a new threat.", "PN"],
        ["America's Next Top Model", 60, "TV-PG", "The models pose for a photo shoot.", "PN"],
        ["Everybody Hates Chris", 30, "TV-PG", "Chris tries to get a date.", ""],
        ["The Jerry Springer Show", 60, "TV-14", "Guests confront each other.", "D"],
        ["Judge Mathis", 60, "TV-PG", "Real cases, real people.", "D"],
      ],
    },
    {
      n: 58, call: "TRAV",
      pool: [
        ["Anthony Bourdain: No Reservations", 60, "TV-PG", "Bourdain visits Vietnam.", ""],
        ["Bizarre Foods With Andrew Zimmern", 60, "TV-PG", "Andrew eats his way through Taiwan.", ""],
        ["Man v. Food", 30, "TV-PG", "Adam takes on an eating challenge.", ""],
        ["Ghost Adventures", 60, "TV-PG", "Investigating a haunted asylum.", "P"],
        ["Samantha Brown's Great Weekends", 60, "TV-G", "A weekend in Charleston.", ""],
      ],
    },
    {
      n: 59, call: "ANPL",
      pool: [
        ["The Crocodile Hunter", 60, "TV-G", "Steve Irwin explores Australia.", ""],
        ["Animal Cops: Houston", 60, "TV-PG", "Officers rescue neglected animals.", ""],
        ["Meerkat Manor", 30, "TV-PG", "The Whiskers face a rival group.", ""],
        ["It's Me or the Dog", 30, "TV-PG", "Victoria trains an unruly dog.", ""],
        ["Dogs 101", 60, "TV-G", "Profiles of popular breeds.", ""],
        ["Whale Wars", 60, "TV-14", "Activists confront whalers.", "PN"],
      ],
    },
    {
      n: 60, call: "QVC",
      pool: [
        ["Fashion Friday", 60, "", "Shopping.", ""],
        ["In the Kitchen With David", 120, "", "Shopping.", ""],
        ["Q Electronics", 60, "", "Shopping.", ""],
        ["Today's Special Value", 60, "", "Shopping.", ""],
        ["Jewelry Showcase", 60, "", "Shopping.", ""],
      ],
    },
  ];

  window.LINEUP = LINEUP;
})();
