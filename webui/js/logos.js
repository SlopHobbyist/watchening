/*
 * Built-in channel icons, picked by channel name, for channels whose playlist
 * gives no tvg-logo (zlive never does). The logos are the ones the channels
 * used around 2005 (or their earliest, for newer channels), to suit the guide.
 *
 * Files: assets/logos/<slug>.png. Nothing is fetched here: Logos.find only
 * returns an address, and the guide requests an image when it draws that
 * channel's row (four rows at a time).
 *
 * Matching: the name is normalised ("US: ESPN 2 HD (East)" -> "espn 2"), then
 * its leading words are looked up longest first with the spaces removed, so
 * "Sky Sports Main Event" finds "skysports" and "ESPN 2" finds "espn2".
 * Aliases starting with "=" only match the whole name ("=USA" must not
 * claim "USA Today").
 */
(function () {
  "use strict";
  const DIR = "assets/logos/";

  // [file slug, aliases...]
  // BEGIN TABLE (generated from the logo catalog; edit freely)
  const TABLE = [
    ["abc", "ABC", "ABC East", "ABC West", "WABC", "WPVI", "WCVB", "WJLA", "WMAR", "WTVD", "WSB", "WPLG", "WFTV"],
    ["cbs", "CBS", "CBS East", "CBS West", "WCBS", "KYW", "WBZ", "WUSA", "WJZ", "WFOR", "WGCL", "WTOG"],
    ["nbc", "NBC", "NBC East", "NBC West", "WNBC", "WCAU", "WHDH", "WBTS", "WRC", "WBAL", "WTVJ", "WXIA"],
    ["fox", "FOX", "Fox East", "Fox West", "WNYW", "WTXF", "WFXT", "WTTG", "WAGA", "WSVN", "WJW"],
    ["cw", "CW", "The CW", "CW Network", "WPIX", "WLVI", "WPSG"],
    ["mynetworktv", "MyNetworkTV", "My Network TV", "MNTV", "WWOR", "My9", "WPHL", "WSBK"],
    ["pbs", "PBS", "WNET", "Thirteen", "WHYY", "WGBH", "WETA", "WNJT", "NJ PBS"],
    ["pbskids", "PBS Kids", "PBS Kids Go"],
    ["ion", "=ION", "ION Television", "ION TV", "ION Plus", "i Independent Television", "Pax TV", "=PAX"],
    ["wgn", "WGN", "WGN America", "Superstation WGN", "WGN 9"],
    ["telemundo", "Telemundo", "WNJU", "WSCV", "WWSI"],
    ["univision", "Univision", "WXTV", "WLTV", "WUVP"],
    ["unimas", "UniMas", "Univision Mas", "TeleFutura"],
    ["galavision", "Galavision"],
    ["azteca", "Azteca America", "Azteca"],
    ["estrella", "Estrella TV", "EstrellaTV", "Estrella"],
    ["metv", "MeTV", "Me TV", "Memorable Entertainment Television"],
    ["antennatv", "Antenna TV"],
    ["cozitv", "Cozi TV", "Cozi"],
    ["cnn", "CNN", "CNN USA", "CNN US", "CNN East", "CNN HD"],
    ["cnni", "CNN International", "CNN Intl", "CNNI"],
    ["hln", "HLN", "Headline News", "CNN Headline News"],
    ["cnnespanol", "CNN en Espanol", "CNN Espanol"],
    ["foxnews", "Fox News", "Fox News Channel", "FNC"],
    ["foxbusiness", "Fox Business", "Fox Business Network", "FBN"],
    ["msnbc", "MSNBC", "MS NOW"],
    ["cnbc", "CNBC", "CNBC USA", "CNBC US"],
    ["bloomberg", "Bloomberg", "Bloomberg TV", "Bloomberg Television"],
    ["bnn", "BNN", "BNN Bloomberg", "Bloomberg BNN"],
    ["bbcamerica", "BBC America"],
    ["bbcnews", "BBC News", "BBC World News", "BBC World", "BBC News 24"],
    ["cspan", "CSPAN", "C SPAN", "CSPAN 1"],
    ["cspan2", "CSPAN 2", "CSPAN2", "C SPAN 2"],
    ["cspan3", "CSPAN 3", "CSPAN3", "C SPAN 3"],
    ["weather", "The Weather Channel", "Weather Channel", "TWC"],
    ["newsnation", "NewsNation", "News Nation"],
    ["newsmax", "Newsmax", "Newsmax TV", "Newsmax 2"],
    ["abcnews", "ABC News", "ABC News Live", "ABC News Now"],
    ["cbsnews", "CBS News", "CBSN", "CBS News 24 7"],
    ["nbcnews", "NBC News", "NBC News Now"],
    ["ny1", "NY1", "NY 1", "Spectrum News NY1", "NY1 News"],
    ["news12", "News 12", "News12"],
    ["skynews", "Sky News"],
    ["qvc", "QVC"],
    ["hsn", "HSN", "Home Shopping Network"],
    ["ewtn", "EWTN"],
    ["tbn", "TBN", "Trinity Broadcasting Network"],
    ["ae", "AE", "A and E", "AE Network", "AE East"],
    ["amc", "AMC", "AMC East"],
    ["bet", "BET", "Black Entertainment Television"],
    ["bravo", "=Bravo"],
    ["comedycentral", "Comedy Central"],
    ["e", "=E", "E Entertainment", "E Entertainment Television", "E Network"],
    ["fx", "FX", "FX Network", "FX East"],
    ["fxx", "FXX"],
    ["fxm", "FXM", "Fox Movie Channel", "FX Movie Channel"],
    ["freeform", "Freeform", "ABC Family"],
    ["lifetime", "Lifetime", "Lifetime Television"],
    ["lmn", "LMN", "Lifetime Movie Network", "Lifetime Movies"],
    ["oxygen", "=Oxygen", "Oxygen True Crime"],
    ["syfy", "SYFY", "Sci Fi", "SciFi", "Sci Fi Channel"],
    ["tbs", "TBS", "TBS Superstation", "TBS East"],
    ["tnt", "TNT", "TNT Drama", "TNT East"],
    ["trutv", "truTV", "Tru TV", "Court TV"],
    ["usa", "=USA", "USA Network"],
    ["tvland", "TV Land"],
    ["paramountnetwork", "Paramount Network", "Spike", "Spike TV"],
    ["vh1", "VH1", "VH1 USA", "VH 1"],
    ["mtv", "MTV", "MTV USA", "MTV East"],
    ["mtv2", "MTV2", "MTV 2"],
    ["cmt", "CMT", "Country Music Television"],
    ["ifc", "IFC", "Independent Film Channel"],
    ["sundance", "Sundance", "SundanceTV", "Sundance TV", "Sundance Channel"],
    ["wetv", "WE tv", "WEtv", "=WE", "Womens Entertainment"],
    ["hallmark", "Hallmark Channel", "Hallmark", "Hallmark Family"],
    ["hallmarkmm", "Hallmark Movies Mysteries", "Hallmark Movies and Mysteries", "Hallmark Movie Channel", "Hallmark Mystery", "HMM"],
    ["ovation", "=Ovation", "Ovation TV"],
    ["reelz", "Reelz", "ReelzChannel"],
    ["gsn", "GSN", "Game Show Network"],
    ["logo", "=Logo", "Logo TV"],
    ["pop", "=Pop", "Pop TV", "TV Guide Channel", "TV Guide Network"],
    ["own", "OWN", "Oprah Winfrey Network"],
    ["up", "=UP", "UPtv", "UP TV", "GMC", "Gospel Music Channel"],
    ["tvone", "TV One", "TVOne"],
    ["fyi", "FYI", "Biography Channel", "Bio Channel"],
    ["axstv", "AXS TV", "AXS", "HDNet"],
    ["fuse", "=Fuse", "Fuse TV"],
    ["tcm", "TCM", "Turner Classic Movies"],
    ["animalplanet", "Animal Planet"],
    ["discovery", "Discovery", "Discovery Channel"],
    ["discoveryturbo", "Discovery Turbo"],
    ["velocity", "Motor Trend", "MotorTrend", "Velocity"],
    ["tlc", "TLC"],
    ["history", "=History", "History Channel", "The History Channel"],
    ["natgeo", "National Geographic", "Nat Geo", "National Geographic Channel", "NatGeo"],
    ["natgeowild", "Nat Geo Wild", "National Geographic Wild", "NatGeo Wild"],
    ["science", "=Science", "Science Channel", "Discovery Science"],
    ["id", "=ID", "Investigation Discovery", "Discovery Times"],
    ["travel", "Travel Channel", "=Travel"],
    ["food", "Food Network", "=Food"],
    ["hgtv", "HGTV"],
    ["diy", "DIY", "DIY Network", "Magnolia Network"],
    ["cooking", "Cooking Channel"],
    ["destinationamerica", "Destination America"],
    ["ahc", "American Heroes Channel", "AHC", "Military Channel"],
    ["smithsonian", "Smithsonian Channel", "=Smithsonian"],
    ["outdoor", "Outdoor Channel"],
    ["sportsman", "Sportsman Channel"],
    ["cartoonnetwork", "Cartoon Network", "=CN"],
    ["adultswim", "Adult Swim", "AdultSwim"],
    ["boomerang", "Boomerang"],
    ["nickelodeon", "Nickelodeon", "=Nick"],
    ["nickjr", "Nick Jr", "Nick Junior", "NickJr"],
    ["nicktoons", "Nicktoons", "Nicktoons Network"],
    ["teennick", "TeenNick", "Teen Nick", "The N"],
    ["disney", "Disney Channel", "=Disney"],
    ["disneyjr", "Disney Junior", "Disney Jr", "Playhouse Disney"],
    ["disneyxd", "Disney XD", "Toon Disney"],
    ["discoveryfamily", "Discovery Family", "Discovery Kids"],
    ["universalkids", "Universal Kids", "Sprout", "PBS Kids Sprout"],
    ["cbeebies", "CBeebies"],
    ["cbbc", "CBBC"],
    ["treehouse", "Treehouse", "Treehouse Kids", "Treehouse TV"],
    ["ytv", "YTV"],
    ["boing", "Boing", "Boing Spain"],
    ["hbo", "HBO", "HBO East", "HBO West", "HBO Drama"],
    ["hbo2", "HBO 2", "HBO2"],
    ["hbocomedy", "HBO Comedy"],
    ["hbofamily", "HBO Family"],
    ["hbosignature", "HBO Signature"],
    ["hbozone", "HBO Zone"],
    ["hbolatino", "HBO Latino"],
    ["cinemax", "Cinemax", "MoreMax", "ActionMax", "ThrillerMax", "5StarMax", "OuterMax", "MovieMax", "MaxPrime"],
    ["showtime", "Showtime", "SHO", "Showtime East", "Paramount Plus with Showtime"],
    ["showtime2", "Showtime 2", "SHO2", "SHO 2"],
    ["showtimeextreme", "Showtime Extreme", "SHO Extreme"],
    ["showtimefamilyzone", "Showtime Family Zone", "SHO Family Zone"],
    ["showtimenext", "Showtime Next", "SHO Next"],
    ["showtimewomen", "Showtime Women", "SHO Women"],
    ["showtimeshowcase", "Showtime Showcase", "SHO Showcase"],
    ["showtimebeyond", "Showtime Beyond", "SHO Beyond"],
    ["tmc", "The Movie Channel", "TMC", "The Movie Channel Xtra"],
    ["flix", "=Flix"],
    ["starz", "Starz", "Starz East"],
    ["starzcinema", "Starz Cinema"],
    ["starzcomedy", "Starz Comedy"],
    ["starzkids", "Starz Kids and Family", "Starz Kids Family", "Starz Kids"],
    ["starzedge", "Starz Edge"],
    ["encore", "Encore", "Starz Encore"],
    ["mgmplus", "MGM Plus", "MGM+", "Epix"],
    ["espn", "ESPN", "ESPN East"],
    ["espn2", "ESPN2", "ESPN 2"],
    ["espnews", "ESPNEWS", "ESPN News"],
    ["espnu", "ESPNU"],
    ["espnclassic", "ESPN Classic"],
    ["espndeportes", "ESPN Deportes"],
    ["secnetwork", "SEC Network", "SECN", "=SEC"],
    ["accnetwork", "ACC Network", "ACCN"],
    ["btn", "Big Ten Network", "BTN", "Big Ten"],
    ["cbssn", "CBS Sports Network", "CBSSN", "=CBS Sports", "CSTV", "CBS College Sports"],
    ["fs1", "Fox Sports 1", "FS1"],
    ["fs2", "Fox Sports 2", "FS2"],
    ["fsn", "Fox Sports", "FSN", "Fox Sports Net", "Bally Sports", "FanDuel Sports Network"],
    ["speed", "=Speed", "Speed Channel"],
    ["nbcsn", "NBCSN", "NBC Sports Network", "Versus", "OLN", "=NBC Sports"],
    ["golf", "Golf Channel", "=Golf", "The Golf Channel"],
    ["tennis", "Tennis Channel", "=Tennis"],
    ["nfl", "NFL Network", "=NFL"],
    ["nflredzone", "NFL RedZone", "RedZone", "NFL Red Zone"],
    ["nbatv", "NBA TV", "NBATV"],
    ["mlbn", "MLB Network"],
    ["nhl", "NHL Network", "=NHL"],
    ["foxdeportes", "Fox Deportes", "Fox Sports en Espanol"],
    ["tudn", "TUDN", "Univision Deportes"],
    ["yes", "YES Network", "=YES"],
    ["msg", "MSG", "MSG Network"],
    ["msgplus", "MSG Plus", "MSG+", "MSG 2", "MSGSN"],
    ["sny", "SNY", "SportsNet New York", "SportsNet NY", "Sprtsnet NY"],
    ["nesn", "NESN", "NESN Plus"],
    ["nbcsphilly", "NBC Sports Philadelphia", "Comcast SportsNet Philadelphia", "CSN Philadelphia", "NBCSP"],
    ["nbcsbayarea", "NBC Sports Bay Area", "Comcast SportsNet Bay Area", "CSN Bay Area"],
    ["monumental", "Monumental Sports Network", "Monumental Sports", "NBC Sports Washington", "Comcast SportsNet MidAtlantic", "CSN MidAtlantic", "CSN Washington"],
    ["nbcsboston", "NBC Sports Boston", "CSN New England", "Comcast SportsNet New England"],
    ["masn", "MASN", "MASN2", "Mid Atlantic Sports Network"],
    ["spectrumsnla", "Spectrum SportsNet LA", "SportsNet LA", "Sprtsnet LA"],
    ["willow", "Willow", "Willow Cricket", "Willow TV"],
    ["racer", "=Racer", "Racer Network"],
    ["dazn", "DAZN"],
    ["ufc", "UFC Fight Pass", "=UFC"],
    ["motogp", "MotoGP", "MotoGP Channel"],
    ["tsn", "TSN", "TSN1", "TSN2", "TSN3", "TSN4", "TSN5"],
    ["cbc", "CBC", "CBC Television"],
    ["bbcone", "BBC One", "BBC 1", "BBC1"],
    ["bbctwo", "BBC Two", "BBC 2", "BBC2"],
    ["skyone", "Sky One", "Sky 1", "Sky1", "Sky Max", "Sky Showcase"],
    ["skyatlantic", "Sky Atlantic"],
    ["skyarts", "Sky Arts"],
    ["skycomedy", "Sky Comedy"],
    ["skycrime", "Sky Crime"],
    ["skydocumentaries", "Sky Documentaries"],
    ["skynature", "Sky Nature"],
    ["skyscifi", "Sky SciFi", "Sky Sci Fi"],
    ["skywitness", "Sky Witness", "Sky Living"],
    ["skykids", "Sky Kids"],
    ["skyuno", "Sky Uno"],
    ["skysports", "Sky Sports", "Sky Sports Main Event", "Sky Sports Premier League", "Sky Sports Football", "Sky Sports Plus"],
    ["skysportsnews", "Sky Sports News"],
    ["skysportsf1", "Sky Sports F1"],
    ["skysportit", "Sky Sport", "Sky Sport Italia", "Sky Sport 24", "Sky Sport Uno"],
    ["skysportnz", "Sky Sport NZ", "Sky Sport 1 NZ", "Sky Sport 2 NZ", "Sky Sport 3 NZ", "Sky Sport 4 NZ", "Sky Sport 5 NZ", "Sky Sport 6 NZ", "Sky Sport 7 NZ", "Sky Sport 8 NZ", "Sky Sport 9 NZ", "Sky Sport Select NZ", "Sky Sport Select"],
    ["skysportde", "Sky Sport Bundesliga", "Sky Sport DE", "Sky Sport Germany", "Sky Sport Austria"],
    ["premiere", "Premiere"],
    ["tntsports", "TNT Sports", "TNT Sport", "BT Sport"],
    ["premiersports", "Premier Sports"],
    ["eleven", "Eleven Sports", "=Eleven"],
    ["beinsports", "beIN", "beIN Sports", "beIN Max", "beIN Sport"],
    ["canalplus", "Canal+", "Canal+ Sport", "Canal+ Extra", "Canal Plus"],
    ["polsat", "Polsat"],
    ["polsatsport", "Polsat Sport", "Polsat Sport Fight", "Polsat Sport Extra"],
    ["sporttv", "Sport TV", "SportTV"],
    ["movistar", "Movistar Plus", "Movistar+", "Movistar"],
    ["movistardeportes", "Movistar Deportes"],
    ["lequipe", "Lequipe", "Lequipe TV", "La Chaine Lequipe"],
    ["ziggo", "Ziggo Sport", "Ziggo"],
    ["go3", "Go3 Sport", "Go3"],
    ["sonysports", "Sony Sports", "Sony Sports Network", "Sony Ten", "Sony Six", "Sony Sports Ten"],
    ["novatv", "Nova TV", "=Nova"],
    ["supersport", "SuperSport", "Spersport"],
    ["foxsportsau", "Fox Sports Australia", "Fox Sports AU", "Fox Sports News", "Fox Sports 501", "Fox Sports 502", "Fox Sports 503", "Fox Sports 504", "Fox Sports 505", "Fox Sports 506", "Fox Sports 507", "Fox Footy", "Fox League", "Fox Cricket"],
    ["sportdigital", "Sportdigital", "Sportdigital Fussball"],
    ["tyc", "TyC Sports", "TyC Sports Internacional", "=TyC"],
    ["trt1", "TRT 1", "TRT1"],
    ["tve", "La 1", "LA 1 Espanol", "TVE", "TVE Internacional", "La 1 TVE", "TVE 1"],
    ["wapa", "WAPA", "WAPA America", "WAPA TV"],
    ["wapadeportes", "WAPA Deportes"],
  ];
  // END TABLE

  const COUNTRY = "us|usa|uk|gb|ca|can|au|nz|ie|es|mx|de|fr|it|pt|pl|nl|in|za|br|ar|tr|ae|qa|sa|hr|sg|lat|latam|latino|eng|en|int";
  const LEAD_TAG = new RegExp(`^\\s*(?:[\\[(|]\\s*(?:${COUNTRY})\\s*[\\])|]|(?:${COUNTRY})\\s*[:|\\-\\u2013\\u2014]+)\\s*`, "i");
  // trailing words that say nothing about which channel it is
  const NOISE = new Set(("hd fhd uhd sd hq lq 4k 8k hevc h264 h265 1080 1080p 1080i 720 720p 576p 480p " +
    "50fps 60fps east west pacific backup test feed alt raw live usa us uk").split(" "));

  /** Name -> words: lower case, accents, prefixes, brackets and noise gone. */
  function words(name) {
    let s = String(name || "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
    for (let i = 0; i < 3 && LEAD_TAG.test(s); i++) s = s.replace(LEAD_TAG, "");
    s = s.toLowerCase();
    const bare = s.replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ");
    if (/[a-z0-9]/.test(bare)) s = bare;           // "[adult swim]" keeps its words
    s = s.replace(/['’.!*&]/g, "")             // A&E -> ae, Sp*rtsNET -> sprtsnet
      .replace(/\+/g, " + ")                        // Canal+ Sport -> canal + sport
      .replace(/[^a-z0-9+]+/g, " ")
      .trim();
    const w = s ? s.split(" ") : [];
    while (w.length > 1 && NOISE.has(w[w.length - 1])) w.pop();
    // split letters from digits so "Sport TV1" and "Sport TV 1" both read "sport tv"
    return w.join(" ").replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").split(" ").filter(Boolean);
  }
  const compact = (name) => words(name).join("");

  const prefix = new Map(), exact = new Map();
  for (const [slug, ...aliases] of TABLE) {
    for (const a of aliases) {
      const whole = a[0] === "=";
      const k = compact(whole ? a.slice(1) : a);
      if (!k) continue;
      const m = whole ? exact : prefix;
      if (!m.has(k)) m.set(k, slug);
    }
  }

  function lookup(name) {
    const w = words(name);
    if (!w.length) return "";
    const all = w.join("");
    if (exact.has(all)) return exact.get(all);
    for (let n = w.length; n > 0; n--) {
      const k = w.slice(0, n).join("");
      if (prefix.has(k)) return prefix.get(k);
    }
    return "";
  }

  /** A channel ({ name, tvgName, tvgId }) -> its icon's address, or "". */
  function find(ch) {
    const id = String(ch.tvgId || "").replace(/\.[a-z]{2,3}(@.*)?$/i, ""); // "ESPN.us" -> "ESPN"
    for (const n of [ch.name, ch.tvgName, id]) {
      const slug = n && lookup(n);
      if (slug) return DIR + slug + ".png";
    }
    return "";
  }

  window.Logos = { find, words };
})();
