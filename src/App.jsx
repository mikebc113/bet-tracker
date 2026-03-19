import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

const filters = ["Day", "Month", "Year", "All Time"];
const TODAY_BOARD_CACHE_KEY = "settleup_today_board_cache_v3";
const BOARD_PAGE_SIZE = 50;

function currency(value) {
  const num = Number(value || 0);
  const absoluteValue = Math.abs(num);
  const formatted = absoluteValue.toLocaleString(undefined, {
    minimumFractionDigits: Number.isInteger(absoluteValue) ? 0 : 2,
    maximumFractionDigits: 2,
  });

  return num < 0 ? `-$${formatted}` : `$${formatted}`;
}

function getNow() {
  return new Date().toISOString();
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isInFilter(dateString, filter) {
  if (filter === "All Time") return true;

  const now = new Date();
  const date = new Date(dateString);

  if (filter === "Day") return date.toDateString() === now.toDateString();

  if (filter === "Month") {
    return (
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear()
    );
  }

  if (filter === "Year") return date.getFullYear() === now.getFullYear();

  return true;
}

function getUserName(users, userId) {
  return users.find((u) => u.id === userId)?.username || "Unknown";
}

function getBetDisplayStatus(bet) {
  if (bet.status === "proposed") return "Waiting";
  if (bet.status === "declined") return "Declined";
  if (bet.status === "accepted") return "Open";
  if (bet.status === "graded") return "Awaiting payment";
  if (bet.status === "settled") return "Settled";
  return bet.status;
}

function sanitizeMoneyInput(value) {
  const clean = value.replace(/[^\d.]/g, "");
  const parts = clean.split(".");
  if (parts.length <= 2) return clean;
  return `${parts[0]}.${parts.slice(1).join("")}`;
}

function normalizeOdds(value) {
  if (value == null) return "";
  let raw = String(value).trim().replace(/[^\d+-]/g, "");
  if (!raw) return "";

  let sign = "";
  if (raw.startsWith("-")) sign = "-";
  else if (raw.startsWith("+")) sign = "+";

  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";

  let num = Number(digits);
  if (!Number.isFinite(num)) return "";

  if (num > 10000) num = 10000;
  if (num === 0) num = 100;

  return `${sign || "+"}${num}`;
}

function formatOddsForDisplay(odds) {
  const normalized = normalizeOdds(odds);
  return normalized || "";
}

function oddsToNumber(odds) {
  const normalized = normalizeOdds(odds);
  if (!normalized) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function calculateWinAmount(stake, odds) {
  const bet = Number(stake);
  const line = oddsToNumber(odds);

  if (!Number.isFinite(bet) || bet <= 0 || !Number.isFinite(line) || line === 0) {
    return "";
  }

  let win = 0;

  if (line > 0) {
    win = (bet * line) / 100;
  } else {
    win = (bet * 100) / Math.abs(line);
  }

  if (!Number.isFinite(win) || win <= 0) return "";

  return win.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function getTodayKey() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function buildCustomPayload(details) {
  return {
    version: 2,
    kind: "custom",
    details: details.trim(),
  };
}

function buildClassicPayload({
  takingTeam,
  againstTeam,
  marketType,
  totalPick,
  totalNumber,
  sidePick,
  sideNumber,
  odds,
}) {
  return {
    version: 2,
    kind: "classic",
    takingTeam: takingTeam.trim(),
    againstTeam: againstTeam.trim(),
    marketType,
    totalPick: marketType === "total" ? totalPick : null,
    totalNumber: marketType === "total" ? totalNumber : null,
    sidePick: marketType === "side" ? sidePick : null,
    sideNumber: marketType === "side" ? sideNumber : null,
    odds: formatOddsForDisplay(odds),
  };
}

function serializeBetPayload(payload) {
  return JSON.stringify(payload);
}

function parseBetPayload(text) {
  const parsed = safeJsonParse(text);
  if (parsed && parsed.version === 2 && parsed.kind) {
    return {
      ...parsed,
      odds:
        parsed.kind === "classic"
          ? formatOddsForDisplay(parsed.odds || "")
          : null,
    };
  }

  return {
    version: 1,
    kind: "custom",
    details: text || "",
  };
}

function flipPayloadForViewer(payload) {
  if (!payload || payload.kind !== "classic") return payload;

  if (payload.marketType === "total") {
    return {
      ...payload,
      takingTeam: payload.againstTeam,
      againstTeam: payload.takingTeam,
      totalPick: payload.totalPick === "over" ? "under" : "over",
    };
  }

  if (payload.marketType === "side") {
    let nextSidePick = payload.sidePick;
    if (payload.sidePick === "plus") nextSidePick = "minus";
    if (payload.sidePick === "minus") nextSidePick = "plus";

    return {
      ...payload,
      takingTeam: payload.againstTeam,
      againstTeam: payload.takingTeam,
      sidePick: nextSidePick,
    };
  }

  return {
    ...payload,
    takingTeam: payload.againstTeam,
    againstTeam: payload.takingTeam,
  };
}

function getPayloadForViewer(bet, currentUserId) {
  const payload = bet.betPayload || parseBetPayload(bet.text);
  const isAcceptor = bet.acceptorId === currentUserId;
  return isAcceptor ? flipPayloadForViewer(payload) : payload;
}

function getBetHeadlineForViewer(bet, currentUserId) {
  const payload = getPayloadForViewer(bet, currentUserId);

  if (payload.kind === "custom") return payload.details || "Custom Bet";

  const oddsText = payload.odds ? ` @ ${payload.odds}` : "";

  if (payload.marketType === "total") {
    return `${payload.takingTeam} vs ${payload.againstTeam} • ${
      payload.totalPick === "over" ? "Over" : "Under"
    } ${payload.totalNumber}${oddsText}`;
  }

  if (payload.marketType === "side") {
    if (payload.sidePick === "ml") {
      return `${payload.takingTeam} ML vs ${payload.againstTeam}${oddsText}`;
    }

    const sign = payload.sidePick === "plus" ? "+" : "-";
    return `${payload.takingTeam} ${sign}${payload.sideNumber} vs ${payload.againstTeam}${oddsText}`;
  }

  return "Bet";
}

function getBetSublineForViewer(bet, currentUserId, users) {
  const proposerName = getUserName(users, bet.proposerId);
  const acceptorName = getUserName(users, bet.acceptorId);
  const payload = getPayloadForViewer(bet, currentUserId);

  let detail = "Custom";
  if (payload.kind === "classic" && payload.marketType === "total") {
    detail = "Classic • Total";
  }
  if (payload.kind === "classic" && payload.marketType === "side") {
    detail = payload.sidePick === "ml" ? "Classic • Moneyline" : "Classic • Spread";
  }

  return `${proposerName} vs ${acceptorName} • ${detail}`;
}

function gradeLabelForViewer(bet, currentUserId) {
  const mine =
    bet.proposerId === currentUserId ? bet.proposerGrade : bet.acceptorGrade;
  const theirs =
    bet.proposerId === currentUserId ? bet.acceptorGrade : bet.proposerGrade;

  if (!mine) return "Pick Win or Loss";
  if (!theirs) return `You picked ${mine}. Waiting for grade`;
  if (mine === theirs) return `Disputed • You: ${mine} • Other: ${theirs}`;
  return `You: ${mine} • Other: ${theirs}`;
}

function getLeaderboard(users, bets, filter) {
  const totals = users.map((user) => {
    const relevant = bets.filter(
      (b) =>
        (b.status === "graded" || b.status === "settled") &&
        isInFilter(b.updatedAt || b.createdAt, filter) &&
        (b.proposerId === user.id || b.acceptorId === user.id)
    );

    let net = 0;

    relevant.forEach((bet) => {
      const winAmount = Number(bet.winAmount || 0);
      const stake = Number(bet.amount || 0);

      if (bet.proposerGrade === "win" && bet.acceptorGrade === "loss") {
        if (bet.proposerId === user.id) net += winAmount;
        if (bet.acceptorId === user.id) net -= stake;
      }

      if (bet.proposerGrade === "loss" && bet.acceptorGrade === "win") {
        if (bet.acceptorId === user.id) net += winAmount;
        if (bet.proposerId === user.id) net -= stake;
      }
    });

    return { userId: user.id, username: user.username, net };
  });

  return totals.filter((x) => x.net !== 0).sort((a, b) => b.net - a.net);
}

function getHeadToHeadTotals(currentUserId, users, bets, filter) {
  const map = new Map();

  bets.forEach((bet) => {
    if (
      (bet.status !== "graded" && bet.status !== "settled") ||
      !isInFilter(bet.updatedAt || bet.createdAt, filter)
    ) {
      return;
    }

    if (bet.proposerId !== currentUserId && bet.acceptorId !== currentUserId) {
      return;
    }

    const otherUserId =
      bet.proposerId === currentUserId ? bet.acceptorId : bet.proposerId;
    const otherName = getUserName(users, otherUserId);

    if (!map.has(otherUserId)) {
      map.set(otherUserId, { userId: otherUserId, username: otherName, net: 0 });
    }

    const item = map.get(otherUserId);
    const winAmount = Number(bet.winAmount || 0);
    const stake = Number(bet.amount || 0);

    if (bet.proposerGrade === "win" && bet.acceptorGrade === "loss") {
      if (bet.proposerId === currentUserId) item.net += winAmount;
      if (bet.acceptorId === currentUserId) item.net -= stake;
    }

    if (bet.proposerGrade === "loss" && bet.acceptorGrade === "win") {
      if (bet.acceptorId === currentUserId) item.net += winAmount;
      if (bet.proposerId === currentUserId) item.net -= stake;
    }
  });

  return Array.from(map.values()).sort((a, b) => b.net - a.net);
}

function getOutstandingBalances(currentUserId, users, bets) {
  const map = new Map();

  bets.forEach((bet) => {
    if (bet.status !== "graded") return;
    if (bet.proposerId !== currentUserId && bet.acceptorId !== currentUserId) {
      return;
    }

    const otherUserId =
      bet.proposerId === currentUserId ? bet.acceptorId : bet.proposerId;
    const otherName = getUserName(users, otherUserId);

    if (!map.has(otherUserId)) {
      map.set(otherUserId, { userId: otherUserId, username: otherName, net: 0 });
    }

    const item = map.get(otherUserId);
    const winAmount = Number(bet.winAmount || 0);
    const stake = Number(bet.amount || 0);

    if (bet.proposerGrade === "win" && bet.acceptorGrade === "loss") {
      if (bet.proposerId === currentUserId) item.net += winAmount;
      if (bet.acceptorId === currentUserId) item.net -= stake;
    }

    if (bet.proposerGrade === "loss" && bet.acceptorGrade === "win") {
      if (bet.acceptorId === currentUserId) item.net += winAmount;
      if (bet.proposerId === currentUserId) item.net -= stake;
    }
  });

  return Array.from(map.values())
    .filter((x) => x.net !== 0)
    .sort((a, b) => b.net - a.net);
}

function mapDbBetToUi(bet) {
  return {
    id: bet.id,
    proposerId: bet.proposer_id,
    acceptorId: bet.acceptor_id,
    text: bet.text,
    betPayload: parseBetPayload(bet.text),
    amount: Number(bet.amount || 0),
    winAmount: Number(bet.win_amount || 0),
    status: bet.status,
    proposerGrade: bet.proposer_grade,
    acceptorGrade: bet.acceptor_grade,
    proposerPaid: bet.proposer_paid,
    acceptorPaid: bet.acceptor_paid,
    createdAt: bet.created_at,
    updatedAt: bet.updated_at,
  };
}

function getTeamLogoFromItem(item, side) {
  const keys =
    side === "home"
      ? [
          "home_logo",
          "homeLogo",
          "home_team_logo",
          "homeTeamLogo",
          "logo_home",
          "home_logo_url",
          "homeLogoUrl",
        ]
      : [
          "away_logo",
          "awayLogo",
          "away_team_logo",
          "awayTeamLogo",
          "logo_away",
          "away_logo_url",
          "awayLogoUrl",
        ];

  for (const key of keys) {
    if (item?.[key]) return item[key];
  }

  if (Array.isArray(item?.teams)) {
    const targetName =
      side === "home"
        ? item.home_team || item.homeTeam
        : item.away_team || item.awayTeam;

    const match = item.teams.find(
      (team) =>
        team?.name === targetName ||
        team?.team === targetName ||
        team?.display_name === targetName
    );

    if (match?.logo) return match.logo;
    if (match?.logoUrl) return match.logoUrl;
    if (match?.image) return match.image;
  }

  return "";
}

function formatBoardTime(commenceTime) {
  if (!commenceTime) return "";

  const date = new Date(commenceTime);
  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString([], {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getInitials(name) {
  return String(name || "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function TeamLogo({ src, name, large = false }) {
  if (src) {
    return (
      <div className={`teamLogoWrap ${large ? "large" : ""}`}>
        <img className="teamLogo" src={src} alt={name} />
      </div>
    );
  }

  return (
    <div className={`teamLogoWrap fallback ${large ? "large" : ""}`}>
      <span>{getInitials(name)}</span>
    </div>
  );
}

function SettleUpLogo({ centered = false, small = false }) {
  return (
    <div className={`logoWrap ${centered ? "centered" : ""} ${small ? "small" : ""}`}>
      <div className="logoIcon">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <linearGradient id="suBlueGreen" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#46D7FF" />
              <stop offset="55%" stopColor="#37C78A" />
              <stop offset="100%" stopColor="#A7E15F" />
            </linearGradient>
            <linearGradient id="suCoin" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#F7D56C" />
              <stop offset="100%" stopColor="#D89E1F" />
            </linearGradient>
          </defs>

          <circle cx="60" cy="60" r="44" fill="none" stroke="url(#suBlueGreen)" strokeWidth="8" opacity="0.95" />
          <path d="M25 40c8-14 23-24 40-24" stroke="#46D7FF" strokeWidth="8" strokeLinecap="round" fill="none" />
          <path d="M93 76c-7 16-22 28-42 28" stroke="#A7E15F" strokeWidth="8" strokeLinecap="round" fill="none" />
          <path d="M68 13l10 5-11 8" fill="#46D7FF" />
          <path d="M54 109l-10-5 11-8" fill="#A7E15F" />

          <ellipse cx="50" cy="58" rx="14" ry="6" fill="url(#suCoin)" />
          <rect x="36" y="58" width="28" height="8" fill="url(#suCoin)" />
          <ellipse cx="50" cy="66" rx="14" ry="6" fill="url(#suCoin)" />

          <ellipse cx="70" cy="49" rx="14" ry="6" fill="url(#suCoin)" />
          <rect x="56" y="49" width="28" height="8" fill="url(#suCoin)" />
          <ellipse cx="70" cy="57" rx="14" ry="6" fill="url(#suCoin)" />

          <path d="M78 77l8 8 18-24" fill="none" stroke="#A7E15F" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />

          <rect x="80" y="34" width="18" height="24" rx="3" fill="#F7FBFF" opacity="0.95" />
          <line x1="84" y1="40" x2="94" y2="40" stroke="#37C78A" strokeWidth="2.4" />
          <line x1="84" y1="45" x2="95" y2="45" stroke="#9DB7C7" strokeWidth="2" />
          <line x1="84" y1="50" x2="91" y2="50" stroke="#9DB7C7" strokeWidth="2" />
        </svg>
      </div>

      <div className="logoText">
        <div className="logoTitle">SettleUp</div>
        <div className="logoSub">BET TRACKER</div>
      </div>
    </div>
  );
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function toNumberOrBlank(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : "";
}

function formatLineNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  return String(Math.abs(num)).replace(/\.0$/, "");
}

function formatSignedLine(sidePick, sideNumber) {
  if (!sideNumber && sideNumber !== 0) return "";
  const sign = sidePick === "minus" ? "-" : "+";
  return `${sign}${sideNumber}`;
}

function findMarket(bookmakers, marketKey) {
  if (!Array.isArray(bookmakers)) return null;

  for (const bookmaker of bookmakers) {
    const market = bookmaker?.markets?.find((m) => m.key === marketKey);
    if (market) return market;
  }

  return null;
}

function isBasketballItem(item) {
  const joined = [
    item?.sport_key,
    item?.sportKey,
    item?.sport_title,
    item?.sportTitle,
    item?.league,
    item?.sport,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return joined.includes("basketball");
}

function extractMoneyline(item) {
  const homeTeam = item.home_team || item.homeTeam;
  const awayTeam = item.away_team || item.awayTeam;

  const h2hMarket = findMarket(item?.bookmakers, "h2h");

  const homeRaw = firstDefined(
    item?.home_moneyline,
    item?.homeMoneyline,
    item?.ml_home,
    item?.home_ml,
    item?.moneyline_home,
    item?.moneylineHome,
    item?.odds?.moneyline?.home,
    h2hMarket?.outcomes?.find((o) => o.name === homeTeam)?.price
  );

  const awayRaw = firstDefined(
    item?.away_moneyline,
    item?.awayMoneyline,
    item?.ml_away,
    item?.away_ml,
    item?.moneyline_away,
    item?.moneylineAway,
    item?.odds?.moneyline?.away,
    h2hMarket?.outcomes?.find((o) => o.name === awayTeam)?.price
  );

  return {
    home: formatOddsForDisplay(homeRaw),
    away: formatOddsForDisplay(awayRaw),
  };
}

function extractSpread(item) {
  const homeTeam = item.home_team || item.homeTeam;
  const awayTeam = item.away_team || item.awayTeam;

  const spreadMarket = findMarket(item?.bookmakers, "spreads");

  let homePoint = toNumberOrBlank(
    firstDefined(
      item?.home_spread,
      item?.homeSpread,
      item?.spread_home,
      item?.spreadHome,
      item?.home_spread_points,
      item?.homeSpreadPoints,
      item?.odds?.spread?.home,
      spreadMarket?.outcomes?.find((o) => o.name === homeTeam)?.point
    )
  );

  let awayPoint = toNumberOrBlank(
    firstDefined(
      item?.away_spread,
      item?.awaySpread,
      item?.spread_away,
      item?.spreadAway,
      item?.away_spread_points,
      item?.awaySpreadPoints,
      item?.odds?.spread?.away,
      spreadMarket?.outcomes?.find((o) => o.name === awayTeam)?.point
    )
  );

  if (homePoint === "" && awayPoint !== "") homePoint = awayPoint * -1;
  if (awayPoint === "" && homePoint !== "") awayPoint = homePoint * -1;

  return {
    home: {
      sidePick: Number(homePoint) >= 0 ? "plus" : "minus",
      sideNumber: formatLineNumber(homePoint),
      odds: "+100",
    },
    away: {
      sidePick: Number(awayPoint) >= 0 ? "plus" : "minus",
      sideNumber: formatLineNumber(awayPoint),
      odds: "+100",
    },
  };
}

function extractTotal(item) {
  const totalMarket = findMarket(item?.bookmakers, "totals");

  const point = firstDefined(
    item?.total,
    item?.total_points,
    item?.totalPoints,
    item?.over_under,
    item?.overUnder,
    item?.odds?.total?.number,
    totalMarket?.outcomes?.[0]?.point
  );

  return {
    number: point === "" ? "" : String(point),
    overOdds: "+100",
    underOdds: "+100",
  };
}

function normalizeBoardGames(items) {
  return items
    .filter((item) => isBasketballItem(item))
    .map((item, index) => {
      const homeTeam = item.home_team || item.homeTeam || "Home";
      const awayTeam = item.away_team || item.awayTeam || "Away";

      return {
        id: item.id || `${homeTeam}-${awayTeam}-${index}`,
        homeTeam,
        awayTeam,
        homeLogo: getTeamLogoFromItem(item, "home"),
        awayLogo: getTeamLogoFromItem(item, "away"),
        sportTitle: item.sport_title || item.sportTitle || "Basketball",
        commenceTime: item.commence_time || item.commenceTime || "",
        moneyline: extractMoneyline(item),
        spread: extractSpread(item),
        total: extractTotal(item),
      };
    });
}

export default function App() {
  const [users, setUsers] = useState([]);
  const [bets, setBets] = useState([]);
  const [session, setSession] = useState(null);

  const [authLoading, setAuthLoading] = useState(true);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [betsLoading, setBetsLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);

  const [page, setPage] = useState("home");
  const [menuOpen, setMenuOpen] = useState(false);

  const [authMode, setAuthMode] = useState("login");
  const [authError, setAuthError] = useState("");

  const [signupUsername, setSignupUsername] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [showCreateBetModal, setShowCreateBetModal] = useState(false);
  const [showBoardBetModal, setShowBoardBetModal] = useState(false);
  const [createBetError, setCreateBetError] = useState("");

  const [opponentSearch, setOpponentSearch] = useState("");
  const [selectedOpponentId, setSelectedOpponentId] = useState("");

  const [boardOpponentSearch, setBoardOpponentSearch] = useState("");
  const [boardSelectedOpponentId, setBoardSelectedOpponentId] = useState("");

  const [betMode, setBetMode] = useState("classic");
  const [customBetDetails, setCustomBetDetails] = useState("");

  const [takingTeam, setTakingTeam] = useState("");
  const [againstTeam, setAgainstTeam] = useState("");
  const [marketType, setMarketType] = useState("side");
  const [totalPick, setTotalPick] = useState("over");
  const [totalNumber, setTotalNumber] = useState("");
  const [sidePick, setSidePick] = useState("ml");
  const [sideNumber, setSideNumber] = useState("");
  const [classicOdds, setClassicOdds] = useState("+100");

  const [boardTakingTeam, setBoardTakingTeam] = useState("");
  const [boardAgainstTeam, setBoardAgainstTeam] = useState("");
  const [boardMarketType, setBoardMarketType] = useState("side");
  const [boardTotalPick, setBoardTotalPick] = useState("over");
  const [boardTotalNumber, setBoardTotalNumber] = useState("");
  const [boardSidePick, setBoardSidePick] = useState("ml");
  const [boardSideNumber, setBoardSideNumber] = useState("");
  const [boardClassicOdds, setBoardClassicOdds] = useState("+100");

  const [betAmount, setBetAmount] = useState("");
  const [winAmount, setWinAmount] = useState("");

  const [boardBetAmount, setBoardBetAmount] = useState("");
  const [boardWinAmount, setBoardWinAmount] = useState("");

  const [leaderboardFilter, setLeaderboardFilter] = useState("All Time");
  const [historyFilter, setHistoryFilter] = useState("All Time");
  const [gradeWarnings, setGradeWarnings] = useState({});

  const [accountUsername, setAccountUsername] = useState("");
  const [accountFirstName, setAccountFirstName] = useState("");
  const [accountLastName, setAccountLastName] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountMessage, setAccountMessage] = useState("");
  const [accountError, setAccountError] = useState("");
  const [savingAccount, setSavingAccount] = useState(false);

  const [todayBoard, setTodayBoard] = useState([]);
  const [todayBoardLoading, setTodayBoardLoading] = useState(false);
  const [todayBoardError, setTodayBoardError] = useState("");
  const [visibleBoardCount, setVisibleBoardCount] = useState(BOARD_PAGE_SIZE);
  const [boardSearch, setBoardSearch] = useState("");

  const gameRefs = useRef({});

  const authUser = session?.user || null;

  const currentUser = useMemo(() => {
    if (!authUser) return null;

    const match =
      users.find((u) => u.id === authUser.id) ||
      users.find((u) => u.email?.toLowerCase() === (authUser.email || "").toLowerCase());

    return (
      match || {
        id: authUser.id,
        username:
          authUser.user_metadata?.username ||
          authUser.email?.split("@")[0] ||
          "User",
        firstName: authUser.user_metadata?.first_name || "",
        lastName: authUser.user_metadata?.last_name || "",
        email: authUser.email || "",
      }
    );
  }, [authUser, users]);

  const validUserIds = useMemo(() => new Set(users.map((u) => u.id)), [users]);

  const validBets = useMemo(
    () =>
      bets.filter(
        (b) => validUserIds.has(b.proposerId) && validUserIds.has(b.acceptorId)
      ),
    [bets, validUserIds]
  );

  const visibleTodayBoard = useMemo(
    () => todayBoard.slice(0, visibleBoardCount),
    [todayBoard, visibleBoardCount]
  );

  const boardSearchMatchIndex = useMemo(() => {
    const query = boardSearch.trim().toLowerCase();
    if (!query) return -1;

    return todayBoard.findIndex((game) => {
      const haystack = `${game.awayTeam} ${game.homeTeam}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [boardSearch, todayBoard]);

  useEffect(() => {
    async function initAuth() {
      const {
        data: { session: existingSession },
      } = await supabase.auth.getSession();

      setSession(existingSession || null);
      setAuthLoading(false);
    }

    initAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession || null);
      setMenuOpen(false);
      if (!nextSession) {
        setShowCreateBetModal(false);
        setShowBoardBetModal(false);
        setPage("home");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const handleClick = () => setMenuOpen(false);
    if (menuOpen) window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [menuOpen]);

  useEffect(() => {
    if (betMode !== "classic") return;
    setWinAmount(calculateWinAmount(betAmount, classicOdds));
  }, [betMode, betAmount, classicOdds]);

  useEffect(() => {
    setBoardWinAmount(calculateWinAmount(boardBetAmount, boardClassicOdds));
  }, [boardBetAmount, boardClassicOdds]);

  useEffect(() => {
    if (betMode !== "classic") return;

    if (marketType === "total") {
      if (classicOdds !== "+100") setClassicOdds("+100");
      return;
    }

    if (sidePick !== "ml" && classicOdds !== "+100") {
      setClassicOdds("+100");
    }
  }, [betMode, marketType, sidePick, classicOdds]);

  useEffect(() => {
    if (boardMarketType === "total") {
      if (boardClassicOdds !== "+100") setBoardClassicOdds("+100");
      return;
    }

    if (boardSidePick !== "ml" && boardClassicOdds !== "+100") {
      setBoardClassicOdds("+100");
    }
  }, [boardMarketType, boardSidePick, boardClassicOdds]);

  useEffect(() => {
    const configuredBoardUrl = import.meta.env.VITE_COMBINED_ODDS_ENDPOINT;

    if (!configuredBoardUrl) {
      setTodayBoard([]);
      return;
    }

    const todayKey = getTodayKey();
    const cached = safeJsonParse(localStorage.getItem(TODAY_BOARD_CACHE_KEY));

    if (cached?.date === todayKey && Array.isArray(cached?.items)) {
      const normalized = normalizeBoardGames(cached.items);
      setTodayBoard(normalized);
      setVisibleBoardCount(BOARD_PAGE_SIZE);
      return;
    }

    async function loadTodayBoard() {
      setTodayBoardLoading(true);
      setTodayBoardError("");

      try {
        const response = await fetch(configuredBoardUrl);
        if (!response.ok) throw new Error("Could not load board");

        const data = await response.json();
        const items = Array.isArray(data)
          ? data
          : Array.isArray(data?.items)
          ? data.items
          : [];

        const normalized = normalizeBoardGames(items);

        setTodayBoard(normalized);
        setVisibleBoardCount(BOARD_PAGE_SIZE);

        localStorage.setItem(
          TODAY_BOARD_CACHE_KEY,
          JSON.stringify({ date: todayKey, items })
        );
      } catch {
        setTodayBoardError("Could not load today's board.");
        setTodayBoard([]);
      } finally {
        setTodayBoardLoading(false);
      }
    }

    loadTodayBoard();
  }, []);

  useEffect(() => {
    if (boardSearchMatchIndex === -1) return;

    const neededCount =
      Math.floor(boardSearchMatchIndex / BOARD_PAGE_SIZE) * BOARD_PAGE_SIZE +
      BOARD_PAGE_SIZE;

    if (visibleBoardCount < neededCount) {
      setVisibleBoardCount(Math.min(neededCount, todayBoard.length));
      return;
    }

    const targetGame = todayBoard[boardSearchMatchIndex];
    const node = targetGame ? gameRefs.current[targetGame.id] : null;

    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [boardSearchMatchIndex, visibleBoardCount, todayBoard]);

  async function ensureCurrentProfile(user) {
    if (!user) return;

    const profile = {
      id: user.id,
      email: user.email || "",
      name:
        user.user_metadata?.username ||
        user.email?.split("@")[0] ||
        "User",
      first_name: user.user_metadata?.first_name || "",
      last_name: user.user_metadata?.last_name || "",
    };

    await supabase.from("profiles").upsert(profile);
  }

  async function loadProfiles() {
    if (!authUser) {
      setUsers([]);
      setProfilesLoading(false);
      return;
    }

    setProfilesLoading(true);

    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, name, first_name, last_name")
      .order("name", { ascending: true });

    if (!error && data) {
      setUsers(
        data.map((u) => ({
          id: u.id,
          email: u.email,
          username: u.name,
          firstName: u.first_name || "",
          lastName: u.last_name || "",
        }))
      );
    }

    setProfilesLoading(false);
  }

  async function loadBets() {
    if (!authUser) {
      setBets([]);
      setBetsLoading(false);
      return;
    }

    setBetsLoading(true);

    const { data, error } = await supabase
      .from("bets")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && data) {
      setBets(data.map(mapDbBetToUi));
    }

    setBetsLoading(false);
  }

  async function cleanupOrphanBets(userRows, betRows) {
    const ids = new Set(userRows.map((u) => u.id));
    const orphanIds = betRows
      .filter((b) => !ids.has(b.proposerId) || !ids.has(b.acceptorId))
      .map((b) => b.id);

    if (!orphanIds.length) return;

    await supabase.from("bets").delete().in("id", orphanIds);
    setBets((prev) => prev.filter((b) => !orphanIds.includes(b.id)));
  }

  useEffect(() => {
    async function boot() {
      if (!authUser) {
        setUsers([]);
        setBets([]);
        setProfilesLoading(false);
        setBetsLoading(false);
        return;
      }

      await ensureCurrentProfile(authUser);
      await Promise.all([loadProfiles(), loadBets()]);
    }

    boot();
  }, [authUser]);
    useEffect(() => {
    if (!users.length || !bets.length) return;
    cleanupOrphanBets(users, bets);
  }, [users, bets]);

  useEffect(() => {
    if (!currentUser) return;
    setAccountUsername(currentUser.username || "");
    setAccountFirstName(currentUser.firstName || "");
    setAccountLastName(currentUser.lastName || "");
    setAccountEmail(currentUser.email || "");
  }, [currentUser]);

  const otherUsers = users.filter((u) => u.id !== currentUser?.id);

  const filteredOpponentOptions = otherUsers.filter((u) =>
    u.username.toLowerCase().includes(opponentSearch.toLowerCase())
  );

  const filteredBoardOpponentOptions = otherUsers.filter((u) =>
    u.username.toLowerCase().includes(boardOpponentSearch.toLowerCase())
  );

  const openBetsFeed = validBets.filter((b) => b.status === "accepted");

  const leaderboard = useMemo(
    () => getLeaderboard(users, validBets, leaderboardFilter),
    [users, validBets, leaderboardFilter]
  );

  const myProposedBets = validBets.filter(
    (b) => currentUser && b.proposerId === currentUser.id && b.status === "proposed"
  );

  const proposedToMe = validBets.filter(
    (b) => currentUser && b.acceptorId === currentUser.id && b.status === "proposed"
  );

  const pendingBets = validBets.filter(
    (b) =>
      currentUser &&
      (b.proposerId === currentUser.id || b.acceptorId === currentUser.id) &&
      b.status === "accepted"
  );

  const unpaidGradedBets = validBets.filter(
    (b) =>
      currentUser &&
      (b.proposerId === currentUser.id || b.acceptorId === currentUser.id) &&
      b.status === "graded"
  );

  const paidHistory = validBets.filter(
    (b) =>
      currentUser &&
      (b.proposerId === currentUser.id || b.acceptorId === currentUser.id) &&
      b.status === "settled"
  );

  const outstanding = useMemo(
    () =>
      currentUser ? getOutstandingBalances(currentUser.id, users, validBets) : [],
    [currentUser, users, validBets]
  );

  const headToHead = useMemo(
    () =>
      currentUser
        ? getHeadToHeadTotals(currentUser.id, users, validBets, historyFilter)
        : [],
    [currentUser, users, validBets, historyFilter]
  );

  async function usernameExists(username, excludeId = null) {
    const clean = username.trim().toLowerCase();

    const { data, error } = await supabase
      .from("profiles")
      .select("id, name")
      .ilike("name", clean)
      .limit(10);

    if (error) return false;

    return data.some((row) => row.id !== excludeId);
  }

  async function handleSignup() {
    setAuthError("");

    const cleanUsername = signupUsername.trim();
    if (!cleanUsername || !signupEmail || !signupPassword) {
      setAuthError("Please fill out all create account fields.");
      return;
    }

    if (cleanUsername.length < 3) {
      setAuthError("Username must be at least 3 characters.");
      return;
    }

    const exists = await usernameExists(cleanUsername);
    if (exists) {
      setAuthError("That username is already taken.");
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email: signupEmail.trim(),
      password: signupPassword,
      options: {
        data: {
          username: cleanUsername,
          first_name: "",
          last_name: "",
        },
      },
    });

    if (error) {
      setAuthError(error.message || "Could not create account.");
      return;
    }

    if (data.user && !data.session) {
      const secondLogin = await supabase.auth.signInWithPassword({
        email: signupEmail.trim(),
        password: signupPassword,
      });

      if (secondLogin.error) {
        setAuthError(
          "Account created, but automatic sign-in did not finish. Turn off email confirmation in Supabase Email Auth while building."
        );
        return;
      }
    }

    setSignupUsername("");
    setSignupEmail("");
    setSignupPassword("");
  }

  async function handleLogin() {
    setAuthError("");

    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim(),
      password: loginPassword,
    });

    if (error) {
      setAuthError("Incorrect email or password.");
      return;
    }

    setLoginEmail("");
    setLoginPassword("");
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setAuthError("");
    setAuthMode("login");
    setShowCreateBetModal(false);
    setShowBoardBetModal(false);
  }

  function goToPage(nextPage) {
    setMenuOpen(false);
    setPageLoading(true);
    setTimeout(() => {
      setPage(nextPage);
      setPageLoading(false);
    }, 180);
  }

  function resetCreateBetModal() {
    setCreateBetError("");
    setOpponentSearch("");
    setSelectedOpponentId("");
    setBetMode("classic");
    setCustomBetDetails("");
    setTakingTeam("");
    setAgainstTeam("");
    setMarketType("side");
    setTotalPick("over");
    setTotalNumber("");
    setSidePick("ml");
    setSideNumber("");
    setClassicOdds("+100");
    setBetAmount("");
    setWinAmount("");
  }

  function resetBoardBetModal() {
    setCreateBetError("");
    setBoardOpponentSearch("");
    setBoardSelectedOpponentId("");
    setBoardTakingTeam("");
    setBoardAgainstTeam("");
    setBoardMarketType("side");
    setBoardTotalPick("over");
    setBoardTotalNumber("");
    setBoardSidePick("ml");
    setBoardSideNumber("");
    setBoardClassicOdds("+100");
    setBoardBetAmount("");
    setBoardWinAmount("");
  }

  function handleAmountChange(value) {
    const clean = sanitizeMoneyInput(value);
    setBetAmount(clean);

    if (betMode === "custom") {
      setWinAmount(clean);
    }
  }

  function handleBoardAmountChange(value) {
    const clean = sanitizeMoneyInput(value);
    setBoardBetAmount(clean);
  }

  function handleClassicOddsChange(value) {
    const raw = String(value).replace(/[^\d+-]/g, "");
    if (!raw) {
      setClassicOdds("");
      return;
    }

    let sign = "";
    if (raw.startsWith("-")) sign = "-";
    else if (raw.startsWith("+")) sign = "+";

    const digits = raw.replace(/[^\d]/g, "");
    if (!digits) {
      setClassicOdds(sign);
      return;
    }

    let num = Number(digits);
    if (num > 10000) num = 10000;
    if (num === 0) num = 100;

    setClassicOdds(`${sign || "+"}${num}`);
  }

  function handleClassicOddsBlur() {
    const normalized = normalizeOdds(classicOdds);
    if (normalized) {
      setClassicOdds(normalized);
      return;
    }

    setClassicOdds("+100");
  }

  function resolveTypedOpponentId() {
    if (selectedOpponentId) return selectedOpponentId;
    const clean = opponentSearch.trim().toLowerCase();
    if (!clean) return "";
    const exact = otherUsers.find((u) => u.username.toLowerCase() === clean);
    return exact?.id || "";
  }

  function resolveTypedBoardOpponentId() {
    if (boardSelectedOpponentId) return boardSelectedOpponentId;
    const clean = boardOpponentSearch.trim().toLowerCase();
    if (!clean) return "";
    const exact = otherUsers.find((u) => u.username.toLowerCase() === clean);
    return exact?.id || "";
  }

  function getCreateBetPayload() {
    if (betMode === "custom") {
      if (!customBetDetails.trim()) return { error: "Add custom bet details." };
      return { payload: buildCustomPayload(customBetDetails) };
    }

    if (!takingTeam.trim() || !againstTeam.trim()) {
      return { error: "Enter both taking and against team names." };
    }

    const oddsValue = oddsToNumber(classicOdds);
    if (!Number.isFinite(oddsValue) || Math.abs(oddsValue) > 10000) {
      return { error: "Enter valid odds between -10000 and +10000." };
    }

    if (marketType === "total") {
      if (!totalNumber.trim()) return { error: "Enter the total number." };

      return {
        payload: buildClassicPayload({
          takingTeam,
          againstTeam,
          marketType,
          totalPick,
          totalNumber: totalNumber.trim(),
          sidePick,
          sideNumber,
          odds: "+100",
        }),
      };
    }

    if (sidePick !== "ml" && !sideNumber.trim()) {
      return { error: "Enter the spread number." };
    }

    return {
      payload: buildClassicPayload({
        takingTeam,
        againstTeam,
        marketType,
        totalPick,
        totalNumber,
        sidePick,
        sideNumber: sidePick === "ml" ? "EVEN" : sideNumber.trim(),
        odds: classicOdds,
      }),
    };
  }

  function getBoardCreateBetPayload() {
    if (!boardTakingTeam.trim() || !boardAgainstTeam.trim()) {
      return { error: "Enter both teams." };
    }

    const oddsValue = oddsToNumber(boardClassicOdds);
    if (!Number.isFinite(oddsValue) || Math.abs(oddsValue) > 10000) {
      return { error: "Enter valid odds between -10000 and +10000." };
    }

    if (boardMarketType === "total") {
      if (!boardTotalNumber.trim()) return { error: "Enter the total number." };

      return {
        payload: buildClassicPayload({
          takingTeam: boardTakingTeam,
          againstTeam: boardAgainstTeam,
          marketType: "total",
          totalPick: boardTotalPick,
          totalNumber: boardTotalNumber.trim(),
          sidePick: null,
          sideNumber: null,
          odds: "+100",
        }),
      };
    }

    if (boardSidePick !== "ml" && !boardSideNumber.trim()) {
      return { error: "Enter the spread number." };
    }

    return {
      payload: buildClassicPayload({
        takingTeam: boardTakingTeam,
        againstTeam: boardAgainstTeam,
        marketType: "side",
        totalPick: null,
        totalNumber: null,
        sidePick: boardSidePick,
        sideNumber: boardSideNumber.trim(),
        odds: boardSidePick === "ml" ? boardClassicOdds : "+100",
      }),
    };
  }

  async function persistNewBet(newBet) {
    const { error } = await supabase.from("bets").insert([
      {
        id: newBet.id,
        proposer_id: newBet.proposerId,
        acceptor_id: newBet.acceptorId,
        text: newBet.text,
        amount: newBet.amount,
        win_amount: newBet.winAmount,
        status: newBet.status,
        proposer_grade: newBet.proposerGrade,
        acceptor_grade: newBet.acceptorGrade,
        proposer_paid: newBet.proposerPaid,
        acceptor_paid: newBet.acceptorPaid,
        created_at: newBet.createdAt,
        updated_at: newBet.updatedAt,
      },
    ]);

    return error;
  }

  async function handleCreateBet() {
    setCreateBetError("");

    if (!currentUser) {
      setCreateBetError("Please sign in.");
      return;
    }

    const resolvedOpponentId = resolveTypedOpponentId();

    if (!resolvedOpponentId) {
      setCreateBetError("Select or type an exact username for your opponent.");
      return;
    }

    if (resolvedOpponentId === currentUser.id) {
      setCreateBetError("You cannot create a bet against yourself.");
      return;
    }

    if (!betAmount || !winAmount) {
      setCreateBetError("Enter bet amount and win amount.");
      return;
    }

    const amountNum = Number(betAmount);
    const winNum = Number(winAmount);

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setCreateBetError("Enter a valid bet amount.");
      return;
    }

    if (!Number.isFinite(winNum) || winNum <= 0) {
      setCreateBetError("Enter a valid win amount.");
      return;
    }

    const result = getCreateBetPayload();
    if (result.error) {
      setCreateBetError(result.error);
      return;
    }

    const newBet = {
      id: crypto.randomUUID(),
      proposerId: currentUser.id,
      acceptorId: resolvedOpponentId,
      text: serializeBetPayload(result.payload),
      betPayload: result.payload,
      amount: amountNum,
      winAmount: winNum,
      status: "proposed",
      proposerGrade: null,
      acceptorGrade: null,
      proposerPaid: false,
      acceptorPaid: false,
      createdAt: getNow(),
      updatedAt: getNow(),
    };

    const error = await persistNewBet(newBet);

    if (error) {
      setCreateBetError("Could not create bet.");
      return;
    }

    setBets((prev) => [newBet, ...prev]);
    setShowCreateBetModal(false);
    resetCreateBetModal();

    setPageLoading(true);
    setTimeout(() => setPageLoading(false), 250);
  }

  async function handleCreateBoardBet() {
    setCreateBetError("");

    if (!currentUser) {
      setCreateBetError("Please sign in.");
      return;
    }

    const resolvedOpponentId = resolveTypedBoardOpponentId();

    if (!resolvedOpponentId) {
      setCreateBetError("Select or type an exact username for your opponent.");
      return;
    }

    if (resolvedOpponentId === currentUser.id) {
      setCreateBetError("You cannot create a bet against yourself.");
      return;
    }

    if (!boardBetAmount || !boardWinAmount) {
      setCreateBetError("Enter bet amount and win amount.");
      return;
    }

    const amountNum = Number(boardBetAmount);
    const winNum = Number(boardWinAmount);

    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setCreateBetError("Enter a valid bet amount.");
      return;
    }

    if (!Number.isFinite(winNum) || winNum <= 0) {
      setCreateBetError("Enter a valid win amount.");
      return;
    }

    const result = getBoardCreateBetPayload();
    if (result.error) {
      setCreateBetError(result.error);
      return;
    }

    const newBet = {
      id: crypto.randomUUID(),
      proposerId: currentUser.id,
      acceptorId: resolvedOpponentId,
      text: serializeBetPayload(result.payload),
      betPayload: result.payload,
      amount: amountNum,
      winAmount: winNum,
      status: "proposed",
      proposerGrade: null,
      acceptorGrade: null,
      proposerPaid: false,
      acceptorPaid: false,
      createdAt: getNow(),
      updatedAt: getNow(),
    };

    const error = await persistNewBet(newBet);

    if (error) {
      setCreateBetError("Could not create bet.");
      return;
    }

    setBets((prev) => [newBet, ...prev]);
    setShowBoardBetModal(false);
    resetBoardBetModal();

    setPageLoading(true);
    setTimeout(() => setPageLoading(false), 250);
  }

  async function deleteBet(betId) {
    const { error } = await supabase.from("bets").delete().eq("id", betId);
    if (error) return;
    setBets((prev) => prev.filter((b) => b.id !== betId));
  }

  async function acceptBet(betId) {
    const updatedAt = getNow();

    const { error } = await supabase
      .from("bets")
      .update({
        status: "accepted",
        updated_at: updatedAt,
        proposer_grade: null,
        acceptor_grade: null,
      })
      .eq("id", betId);

    if (error) return;

    setBets((prev) =>
      prev.map((b) =>
        b.id === betId
          ? {
              ...b,
              status: "accepted",
              proposerGrade: null,
              acceptorGrade: null,
              updatedAt,
            }
          : b
      )
    );

    setGradeWarnings((prev) => {
      const copy = { ...prev };
      delete copy[betId];
      return copy;
    });
  }

  async function declineBet(betId) {
    const updatedAt = getNow();

    const { error } = await supabase
      .from("bets")
      .update({
        status: "declined",
        updated_at: updatedAt,
      })
      .eq("id", betId);

    if (error) return;

    setBets((prev) =>
      prev.map((b) => (b.id === betId ? { ...b, status: "declined", updatedAt } : b))
    );
  }

  async function gradeBet(betId, result) {
    if (!currentUser) return;

    const selectedBet = bets.find((b) => b.id === betId);
    if (!selectedBet) return;

    const warning = gradeWarnings[betId];
    const isProposer = selectedBet.proposerId === currentUser.id;
    const otherGrade = isProposer ? selectedBet.acceptorGrade : selectedBet.proposerGrade;

    if (!otherGrade) {
      const updatedAt = getNow();
      const { error } = await supabase
        .from("bets")
        .update({
          proposer_grade: isProposer ? result : selectedBet.proposerGrade,
          acceptor_grade: isProposer ? selectedBet.acceptorGrade : result,
          status: "accepted",
          updated_at: updatedAt,
        })
        .eq("id", betId);

      if (error) return;

      setBets((prev) =>
        prev.map((b) =>
          b.id === betId
            ? {
                ...b,
                proposerGrade: isProposer ? result : b.proposerGrade,
                acceptorGrade: isProposer ? b.acceptorGrade : result,
                status: "accepted",
                updatedAt,
              }
            : b
        )
      );

      setGradeWarnings((prev) => {
        const copy = { ...prev };
        delete copy[betId];
        return copy;
      });

      return;
    }

    if (result === otherGrade && (!warning || warning !== result)) {
      setGradeWarnings((prev) => ({ ...prev, [betId]: result }));
      return;
    }

    if (warning && result !== otherGrade) {
      const updatedAt = getNow();

      const { error } = await supabase
        .from("bets")
        .update({
          proposer_grade: isProposer ? result : null,
          acceptor_grade: isProposer ? null : result,
          status: "accepted",
          updated_at: updatedAt,
        })
        .eq("id", betId);

      if (error) return;

      setBets((prev) =>
        prev.map((b) =>
          b.id === betId
            ? {
                ...b,
                proposerGrade: isProposer ? result : null,
                acceptorGrade: isProposer ? null : result,
                status: "accepted",
                updatedAt,
              }
            : b
        )
      );

      setGradeWarnings((prev) => {
        const copy = { ...prev };
        delete copy[betId];
        return copy;
      });

      return;
    }

    if (result !== otherGrade) {
      const updatedAt = getNow();
      const nextProposerGrade = isProposer ? result : selectedBet.proposerGrade;
      const nextAcceptorGrade = isProposer ? selectedBet.acceptorGrade : result;

      const { error } = await supabase
        .from("bets")
        .update({
          proposer_grade: nextProposerGrade,
          acceptor_grade: nextAcceptorGrade,
          status: "graded",
          updated_at: updatedAt,
        })
        .eq("id", betId);

      if (error) return;

      setBets((prev) =>
        prev.map((b) =>
          b.id === betId
            ? {
                ...b,
                proposerGrade: nextProposerGrade,
                acceptorGrade: nextAcceptorGrade,
                status: "graded",
                updatedAt,
              }
            : b
        )
      );

      setGradeWarnings((prev) => {
        const copy = { ...prev };
        delete copy[betId];
        return copy;
      });
    }
  }

  async function settleBet(betId) {
    const updatedAt = getNow();

    const { error } = await supabase
      .from("bets")
      .update({
        proposer_paid: true,
        acceptor_paid: true,
        status: "settled",
        updated_at: updatedAt,
      })
      .eq("id", betId);

    if (error) return;

    setBets((prev) =>
      prev.map((b) =>
        b.id === betId
          ? {
              ...b,
              proposerPaid: true,
              acceptorPaid: true,
              status: "settled",
              updatedAt,
            }
          : b
      )
    );
  }

  async function settleAllWithUser(otherUserId) {
    if (!currentUser) return;

    const rows = validBets.filter(
      (b) =>
        b.status === "graded" &&
        ((b.proposerId === currentUser.id && b.acceptorId === otherUserId) ||
          (b.proposerId === otherUserId && b.acceptorId === currentUser.id))
    );

    if (!rows.length) return;

    const ids = rows.map((b) => b.id);
    const updatedAt = getNow();

    const { error } = await supabase
      .from("bets")
      .update({
        proposer_paid: true,
        acceptor_paid: true,
        status: "settled",
        updated_at: updatedAt,
      })
      .in("id", ids);

    if (error) return;

    setBets((prev) =>
      prev.map((b) =>
        ids.includes(b.id)
          ? {
              ...b,
              proposerPaid: true,
              acceptorPaid: true,
              status: "settled",
              updatedAt,
            }
          : b
      )
    );
  }

  async function handleSaveAccount() {
    if (!currentUser) return;

    setSavingAccount(true);
    setAccountError("");
    setAccountMessage("");

    const cleanUsername = accountUsername.trim();
    if (!cleanUsername) {
      setAccountError("Username is required.");
      setSavingAccount(false);
      return;
    }

    if (cleanUsername.length < 3) {
      setAccountError("Username must be at least 3 characters.");
      setSavingAccount(false);
      return;
    }

    const exists = await usernameExists(cleanUsername, currentUser.id);
    if (exists) {
      setAccountError("That username is already taken.");
      setSavingAccount(false);
      return;
    }

    const profilePayload = {
      id: currentUser.id,
      name: cleanUsername,
      first_name: accountFirstName.trim(),
      last_name: accountLastName.trim(),
      email: accountEmail.trim(),
    };

    const profileResult = await supabase.from("profiles").upsert(profilePayload);

    if (profileResult.error) {
      setAccountError("Could not save account details.");
      setSavingAccount(false);
      return;
    }

    const authPayload = {
      data: {
        username: cleanUsername,
        first_name: accountFirstName.trim(),
        last_name: accountLastName.trim(),
      },
    };

    if (
      accountEmail.trim() &&
      accountEmail.trim().toLowerCase() !== (currentUser.email || "").toLowerCase()
    ) {
      authPayload.email = accountEmail.trim();
    }

    const { error } = await supabase.auth.updateUser(authPayload);

    if (error) {
      setAccountError(
        "Profile saved, but auth email update may require confirmation in Supabase."
      );
      setSavingAccount(false);
      await loadProfiles();
      return;
    }

    await loadProfiles();
    setAccountMessage("Account updated.");
    setSavingAccount(false);
  }

  function renderGradeWarning(betId) {
    return gradeWarnings[betId] ? (
      <div className="errorText compactError">
        The other Player has selected a different outcome, are you sure?
      </div>
    ) : null;
  }

  function openBoardBetModal(selection) {
    setCreateBetError("");
    setShowBoardBetModal(true);
    setBoardOpponentSearch("");
    setBoardSelectedOpponentId("");
    setBoardBetAmount("");
    setBoardWinAmount("");

    setBoardTakingTeam(selection.takingTeam || "");
    setBoardAgainstTeam(selection.againstTeam || "");
    setBoardMarketType(selection.marketType || "side");

    if (selection.marketType === "total") {
      setBoardTotalPick(selection.totalPick || "over");
      setBoardTotalNumber(String(selection.totalNumber || ""));
      setBoardSidePick("ml");
      setBoardSideNumber("");
      setBoardClassicOdds("+100");
      return;
    }

    setBoardTotalPick("over");
    setBoardTotalNumber("");
    setBoardSidePick(selection.sidePick || "ml");
    setBoardSideNumber(selection.sideNumber ? String(selection.sideNumber) : "");
    setBoardClassicOdds(
      selection.sidePick === "ml"
        ? formatOddsForDisplay(selection.odds || "") || "+100"
        : "+100"
    );
  }

  function renderBetCard(bet, options = {}) {
    if (!currentUser) return null;

    const proposerName = getUserName(users, bet.proposerId);
    const acceptorName = getUserName(users, bet.acceptorId);
    const iAmWinner =
      (bet.proposerId === currentUser.id &&
        bet.proposerGrade === "win" &&
        bet.acceptorGrade === "loss") ||
      (bet.acceptorId === currentUser.id &&
        bet.acceptorGrade === "win" &&
        bet.proposerGrade === "loss");

    const paymentText = iAmWinner ? "Got Paid!" : "Paid Up!";
    const headline = getBetHeadlineForViewer(bet, currentUser.id);
    const subline = getBetSublineForViewer(bet, currentUser.id, users);

    return (
      <div key={bet.id} className="betCard">
        <div className="betGlow" />
        <div className="betRowTop">
          <div className="betLeft">
            <div className="betTitle">{headline}</div>
            <div className="betSub">{subline}</div>
          </div>

          <div className="betRight">
            {options.showAcceptDecline ? (
              <div className="inlineBtns">
                <button className="greenBtn miniBtn" onClick={() => acceptBet(bet.id)}>
                  Accept
                </button>
                <button className="ghostBtn miniBtn" onClick={() => declineBet(bet.id)}>
                  Decline
                </button>
              </div>
            ) : options.showGrade ? (
              <div className="inlineBtns">
                <button className="greenBtn miniBtn" onClick={() => gradeBet(bet.id, "win")}>
                  Win
                </button>
                <button className="ghostBtn miniBtn" onClick={() => gradeBet(bet.id, "loss")}>
                  Loss
                </button>
              </div>
            ) : options.showPayment ? (
              <button className="greenBtn miniBtn" onClick={() => settleBet(bet.id)}>
                {paymentText}
              </button>
            ) : options.showDelete ? (
              <button className="ghostBtn miniBtn" onClick={() => deleteBet(bet.id)}>
                Delete
              </button>
            ) : (
              <div className="statusPill">{getBetDisplayStatus(bet)}</div>
            )}
          </div>
        </div>

        <div className="betRowBottom">
          <span>
            <strong>Stake:</strong> {currency(bet.amount)}
          </span>
          <span>
            <strong>To Win:</strong> {currency(bet.winAmount)}
          </span>
          <span>
            <strong>Proposed:</strong> {proposerName}
          </span>
          <span>
            <strong>Opponent:</strong> {acceptorName}
          </span>
        </div>

        {options.showGrade && (
          <>
            <div className="softText compactMeta">{gradeLabelForViewer(bet, currentUser.id)}</div>
            {renderGradeWarning(bet.id)}
          </>
        )}
      </div>
    );
  }

  function renderSkeletonScreen() {
    return (
      <div className="pageGrid">
        <section className="prettyCard">
          <div className="skeleton skeletonLogo" />
          <div className="skeleton skeletonTitle" />
          <div className="skeleton skeletonSub" />

          <div className="sectionBlock">
            <div className="scrollList">
              {Array.from({ length: 4 }).map((_, i) => (
                <div className="betCard skeletonCard" key={i}>
                  <div className="skeleton skeletonLineLg" />
                  <div className="skeleton skeletonLineSm" />
                  <div className="skeletonRow">
                    <div className="skeleton skeletonBox" />
                    <div className="skeleton skeletonBox" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    );
  }

  const showLockedState =
    authLoading || !session || profilesLoading || betsLoading;
  return (
    <>
      <style>{`
        :root {
          color-scheme: dark;
          font-family: Inter, system-ui, Arial, sans-serif;
          --bg-1: #07090d;
          --bg-2: #0d1118;
          --line: rgba(255,255,255,0.11);
          --text: #f4f7fb;
          --muted: #98a1ae;
          --green: #26cf60;
          --teal: #46d7ff;
          --lime: #a7e15f;
          --card: rgba(10, 15, 24, 0.88);
          --soft: rgba(255,255,255,0.045);
          --stickyOffset: 0px;
          --topbarHeight: 96px;
          --homeStickyTop: calc(var(--topbarHeight) + 8px);
        }

        * { box-sizing: border-box; }

        html, body, #root {
          min-height: 100%;
        }

        body {
          margin: 0;
          color: var(--text);
          background:
            radial-gradient(circle at top, rgba(70,215,255,0.08), transparent 28%),
            radial-gradient(circle at bottom, rgba(167,225,95,0.10), transparent 26%),
            linear-gradient(180deg, #07090d 0%, #0b1018 45%, #05070a 100%);
        }

        body::before {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(180deg, rgba(255,255,255,0.02) 1px, transparent 1px);
          background-size: 64px 64px;
          opacity: 0.08;
        }

        button, input, textarea {
          font: inherit;
        }

        button {
          transition: transform 0.12s ease, filter 0.12s ease, background 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
        }

        button:active {
          transform: scale(0.97);
          filter: brightness(0.92);
        }

        .appShell {
          min-height: 100vh;
          padding: 18px;
        }

        .pageGrid {
          max-width: 1220px;
          margin: 0 auto;
        }

        .shellFade {
          animation: pageFade 220ms ease;
        }

        @keyframes pageFade {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .topbar {
          max-width: 1220px;
          margin: 0 auto 18px auto;
          display: grid;
          grid-template-columns: 1fr auto;
          align-items: start;
          gap: 12px;
          position: sticky;
          top: 0;
          z-index: 100;
          padding: 12px 14px;
          border-radius: 24px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(9,13,20,0.96);
          box-shadow: 0 18px 42px rgba(0,0,0,0.36);
          backdrop-filter: blur(16px);
        }

        .logoCenterWrap {
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 56px;
          position: relative;
        }

        .headerGlow {
          position: absolute;
          left: 0;
          right: 0;
          bottom: -4px;
          height: 3px;
          background: linear-gradient(90deg, transparent 0%, var(--green) 14%, var(--teal) 48%, #7c74ff 82%, transparent 100%);
          box-shadow: 0 0 22px rgba(70,215,255,0.5);
          border-radius: 999px;
          opacity: 0.9;
        }

        .logoWrap {
          display: inline-flex;
          align-items: center;
          gap: 14px;
          position: relative;
        }

        .logoWrap.centered {
          justify-content: center;
        }

        .logoWrap.small {
          gap: 10px;
        }

        .logoIcon {
          width: 68px;
          height: 68px;
          filter: drop-shadow(0 0 22px rgba(70,215,255,0.18));
        }

        .logoWrap.small .logoIcon {
          width: 52px;
          height: 52px;
        }

        .logoText {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .logoTitle {
          font-size: 52px;
          line-height: 0.95;
          font-weight: 900;
          letter-spacing: -0.04em;
          background: linear-gradient(90deg, var(--teal) 0%, #44d1d2 40%, var(--lime) 100%);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          text-shadow: 0 0 20px rgba(70,215,255,0.14);
        }

        .logoWrap.small .logoTitle {
          font-size: 34px;
        }

        .logoSub {
          font-size: 13px;
          letter-spacing: 0.25em;
          font-weight: 800;
          color: #f7fbff;
        }

        .logoWrap.small .logoSub {
          font-size: 11px;
        }

        .menuWrap {
          position: relative;
          justify-self: end;
        }

        .menuBtn {
          width: 50px;
          height: 50px;
          border-radius: 18px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.05);
          color: white;
          cursor: pointer;
          font-size: 22px;
          backdrop-filter: blur(12px);
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
        }

        .menuPanel {
          position: absolute;
          right: 0;
          top: 58px;
          width: 230px;
          background: rgba(13,17,24,0.98);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 18px;
          overflow: hidden;
          z-index: 130;
          box-shadow: 0 18px 45px rgba(0,0,0,0.48);
          backdrop-filter: blur(18px);
        }

        .menuPanel button {
          width: 100%;
          text-align: left;
          padding: 13px 15px;
          background: transparent;
          border: none;
          color: white;
          cursor: pointer;
        }

        .menuPanel button:hover {
          background: rgba(255,255,255,0.06);
        }

        .prettyCard {
          position: relative;
          background:
            radial-gradient(circle at top left, rgba(70,215,255,0.08), transparent 24%),
            radial-gradient(circle at bottom center, rgba(167,225,95,0.06), transparent 22%),
            linear-gradient(180deg, rgba(13,17,24,0.92), rgba(7,10,15,0.94));
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 28px;
          padding: 20px;
          box-shadow: 0 22px 50px rgba(0,0,0,0.34);
          backdrop-filter: blur(10px);
          overflow: hidden;
        }

        .prettyCard::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(circle at 10% 12%, rgba(70,215,255,0.10), transparent 14%),
            radial-gradient(circle at 90% 86%, rgba(167,225,95,0.10), transparent 18%);
          opacity: 0.5;
        }

        .pageHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 8px;
          position: relative;
          z-index: 1;
        }

        .pageHeader h2 {
          margin: 0;
          font-size: 20px;
        }

        .sectionBlock {
          margin-top: 20px;
          position: relative;
          z-index: 1;
        }

        .sectionBlock h3 {
          margin: 0 0 12px 0;
          font-size: 18px;
        }

        .greenBtn,
        .ghostBtn,
        .filterBtn,
        .tabBtn,
        .radioBtn,
        .lineTag {
          border-radius: 18px;
          padding: 10px 16px;
          cursor: pointer;
        }

        .greenBtn {
          border: 1px solid rgba(38,207,96,0.30);
          background: linear-gradient(180deg, rgba(38,207,96,0.95) 0%, rgba(20,168,84,0.96) 100%);
          color: white;
          font-weight: 800;
          box-shadow: 0 10px 26px rgba(38,207,96,0.20), 0 0 18px rgba(38,207,96,0.12);
        }

        .greenBtn:hover {
          filter: brightness(1.05);
        }

        .ghostBtn,
        .filterBtn,
        .tabBtn,
        .radioBtn,
        .lineTag {
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
          color: #edf2f7;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
        }

        .ghostBtn:hover,
        .filterBtn:hover,
        .tabBtn:hover,
        .radioBtn:hover {
          background: rgba(255,255,255,0.06);
        }

        .filterBtn.active,
        .tabBtn.active,
        .radioBtn.active {
          background: linear-gradient(180deg, rgba(38,207,96,0.96) 0%, rgba(20,168,84,0.96) 100%);
          border-color: rgba(38,207,96,0.32);
          color: white;
          box-shadow: 0 0 18px rgba(38,207,96,0.16);
        }

        .miniBtn {
          min-width: 130px;
          height: 54px;
          padding: 0 22px;
          border-radius: 22px;
          font-size: 17px;
        }

        .statusPill {
          min-width: 118px;
          height: 54px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.03);
          border-radius: 24px;
          padding: 0 18px;
          font-size: 17px;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
        }

        .full {
          width: 100%;
        }

        .filterRow,
        .inlineBtns,
        .radioRow,
        .authToggleRow,
        .boardMetaRow {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .authToggleRow .tabBtn {
          flex: 1 1 0;
          text-align: center;
        }

        .modalBackdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 18px;
          z-index: 150;
        }

        .modal {
          width: 100%;
          max-width: 560px;
          max-height: min(88vh, 820px);
          overflow-y: auto;
          border-radius: 28px;
          padding: 22px;
          position: relative;
          background:
            radial-gradient(circle at top, rgba(70,215,255,0.08), transparent 28%),
            radial-gradient(circle at bottom, rgba(167,225,95,0.08), transparent 26%),
            linear-gradient(180deg, rgba(10,14,22,0.98) 0%, rgba(5,8,13,0.98) 100%);
          border: 1px solid rgba(255,255,255,0.10);
          box-shadow: 0 24px 60px rgba(0,0,0,0.58);
        }

        .authModal {
          max-width: 500px;
        }

        .createBetModal {
          max-width: 540px;
        }

        .boardBetModal {
          max-width: 470px;
          max-height: min(82vh, 700px);
          padding: 16px;
        }

        .modalTitle {
          margin: 10px 0 10px 0;
          font-size: 28px;
          font-weight: 900;
          text-align: center;
        }

        .boardBetModal .modalTitle {
          font-size: 22px;
          margin: 8px 0 6px 0;
        }

        .modalCopy {
          color: var(--muted);
          text-align: center;
          margin: 0 0 12px 0;
        }

        .boardBetModal .modalCopy {
          font-size: 12px;
          margin-bottom: 8px;
        }

        .closeX {
          position: absolute;
          right: 14px;
          top: 12px;
          border: none;
          background: transparent;
          color: white;
          font-size: 28px;
          cursor: pointer;
        }

        .fieldGroup {
          margin-top: 12px;
        }

        .fieldGroup label {
          display: block;
          margin-bottom: 6px;
          color: #d4dce6;
          font-size: 13px;
          font-weight: 600;
        }

        input,
        textarea {
          width: 100%;
          padding: 13px 14px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
          color: white;
          outline: none;
        }

        .boardBetModal input,
        .boardBetModal textarea {
          padding: 11px 12px;
          border-radius: 14px;
        }

        input:focus,
        textarea:focus {
          border-color: rgba(70,215,255,0.35);
          box-shadow: 0 0 0 3px rgba(70,215,255,0.10);
        }

        textarea {
          min-height: 96px;
          resize: vertical;
        }

        .twoCol {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .threeCol {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
        }

        .moneyInput {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 12px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
        }

        .boardBetModal .moneyInput {
          border-radius: 14px;
        }

        .moneyInput span {
          color: var(--green);
          font-weight: 800;
          white-space: nowrap;
        }

        .moneyInput input {
          border: none;
          background: transparent;
          box-shadow: none;
        }

        .oddsInput span {
          color: var(--teal);
        }

        .helperText {
          margin-top: 6px;
          color: var(--muted);
          font-size: 12px;
        }

        .autocompleteBox {
          margin-top: 8px;
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 16px;
          overflow: hidden;
          background: rgba(12,16,22,0.96);
        }

        .autocompleteItem {
          width: 100%;
          border: none;
          background: transparent;
          color: white;
          text-align: left;
          padding: 11px 12px;
          cursor: pointer;
        }

        .autocompleteItem:hover {
          background: rgba(255,255,255,0.06);
        }

        .smallPad {
          padding: 11px 12px;
        }

        .searchWrap {
          margin-top: 8px;
        }

        .scrollList {
          display: grid;
          gap: 14px;
        }

        .betCard {
          position: relative;
          overflow: hidden;
          background:
            radial-gradient(circle at top center, rgba(70,215,255,0.07), transparent 30%),
            linear-gradient(180deg, rgba(16,21,30,0.93) 0%, rgba(10,14,20,0.94) 100%);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 30px;
          padding: 20px 24px;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.015);
        }

        .betGlow {
          position: absolute;
          inset: -1px;
          pointer-events: none;
          border-radius: inherit;
          background:
            linear-gradient(90deg, rgba(38,207,96,0.18), rgba(70,215,255,0.14), rgba(124,116,255,0.14));
          opacity: 0.45;
          filter: blur(18px);
        }

        .skeletonCard .betGlow {
          display: none;
        }

        .betRowTop {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 16px;
          align-items: center;
        }

        .betLeft {
          min-width: 0;
        }

        .betRight {
          display: flex;
          justify-content: flex-end;
          align-items: center;
        }

        .betTitle {
          font-weight: 900;
          font-size: 19px;
          line-height: 1.2;
          letter-spacing: -0.01em;
        }

        .betSub {
          color: var(--muted);
          font-size: 13px;
          margin-top: 7px;
        }

        .betRowBottom {
          position: relative;
          z-index: 1;
          display: flex;
          flex-wrap: wrap;
          gap: 10px 30px;
          color: #e1e7ee;
          font-size: 14px;
          margin-top: 14px;
        }

        .teamLogoWrap {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.12);
          overflow: hidden;
          flex: 0 0 28px;
        }

        .teamLogoWrap.large {
          width: 42px;
          height: 42px;
          flex: 0 0 42px;
        }

        .teamLogoWrap.fallback {
          font-size: 10px;
          font-weight: 900;
          color: #fff;
          background: linear-gradient(180deg, rgba(70,215,255,0.22), rgba(38,207,96,0.18));
        }

        .teamLogo {
          width: 100%;
          height: 100%;
          object-fit: contain;
          background: white;
        }

        .tableWrap {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
        }

        th,
        td {
          text-align: left;
          padding: 13px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }

        th {
          color: var(--muted);
          font-size: 13px;
        }

        .greenText {
          color: var(--green);
          font-weight: 800;
        }

        .redText {
          color: #ff6b6b;
          font-weight: 800;
        }

        .emptyState,
        .emptyCell {
          color: #8f98a4;
          padding: 18px 6px;
          text-align: center;
        }

        .settleCtaCell {
          width: 220px;
        }

        .settleInlineBtn {
          min-width: 170px;
        }

        .boardSlipMatchup {
          margin-top: 14px;
          padding: 14px;
          border-radius: 18px;
          background: rgba(255,255,255,0.035);
          border: 1px solid rgba(255,255,255,0.08);
          font-size: 16px;
          font-weight: 900;
          text-align: center;
        }

        .boardLockedInput input {
          opacity: 0.88;
        }

        .skeleton {
          position: relative;
          overflow: hidden;
          border-radius: 16px;
          background: rgba(255,255,255,0.07);
        }

        .skeleton::after {
          content: "";
          position: absolute;
          inset: 0;
          transform: translateX(-100%);
          background: linear-gradient(
            90deg,
            rgba(255,255,255,0) 0%,
            rgba(255,255,255,0.08) 45%,
            rgba(255,255,255,0.20) 50%,
            rgba(255,255,255,0.08) 55%,
            rgba(255,255,255,0) 100%
          );
          animation: skeletonSweep 1.4s ease-in-out infinite;
        }

        .skeletonLogo {
          width: 240px;
          height: 72px;
          margin: 0 auto 10px auto;
        }

        .skeletonTitle {
          width: 210px;
          height: 28px;
          margin: 0 auto 8px auto;
        }

        .skeletonSub {
          width: 180px;
          height: 16px;
          margin: 0 auto;
        }

        .skeletonLineLg {
          width: 74%;
          height: 18px;
          margin-bottom: 10px;
        }

        .skeletonLineSm {
          width: 46%;
          height: 14px;
          margin-bottom: 12px;
        }

        .skeletonRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .skeletonBox {
          width: 100%;
          height: 46px;
        }

        @keyframes skeletonSweep {
          100% { transform: translateX(100%); }
        }

        .msgOk {
          color: #b3f5c9;
          margin-top: 12px;
          font-size: 13px;
        }

        .msgErr,
        .errorText {
          color: #ff8f8f;
          margin-top: 12px;
          font-size: 13px;
        }

        .softText {
          color: var(--muted);
        }

        .compactMeta {
          margin-top: 11px;
          font-size: 13px;
          color: var(--muted);
        }

        .homePage {
          max-width: 1220px;
          margin: 0 auto;
        }

        .homeStickyWrap {
  position: sticky;
  top: var(--homeStickyTop);
  z-index: 90;
  margin-bottom: 14px;
  border-radius: 28px;
  border: 1px solid rgba(255,255,255,0.08);
  box-shadow: 0 18px 40px rgba(0,0,0,0.34);
  overflow: hidden;
  isolation: isolate;
  background: #0b1018;
}

.homeStickyWrap::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(circle at top left, rgba(70,215,255,0.08), transparent 24%),
    radial-gradient(circle at bottom center, rgba(167,225,95,0.06), transparent 22%),
    linear-gradient(180deg, rgba(13,17,24,0.98), rgba(7,10,15,0.99));
}

.homeStickyWrap::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(circle at 10% 12%, rgba(70,215,255,0.10), transparent 14%),
    radial-gradient(circle at 90% 86%, rgba(167,225,95,0.10), transparent 18%);
  opacity: 0.5;
}

.homeStickyPanel {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 0;
  padding: 16px;
  background: transparent;
}

.homeStickyRow {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
}

.homeStickyRow + .homeStickyRow {
  border-top: 1px solid rgba(255,255,255,0.06);
}

.searchWrap {
  margin-top: 0;
  padding-top: 10px;
  border-top: 1px solid rgba(255,255,255,0.06);
  position: relative;
  z-index: 1;
}

        .homeStickyRow {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }

        .homeStickyUserBlock {
          min-width: 0;
        }

        .homeStickyEyebrow {
          color: var(--muted);
          font-size: 12px;
          margin-bottom: 4px;
        }

        .homeStickyUser {
          font-size: 16px;
          font-weight: 800;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .homeStickyBoardTitle {
          font-size: 20px;
          font-weight: 900;
          margin: 0;
        }

        .homeStickyMeta {
          color: var(--muted);
          font-size: 12px;
          white-space: nowrap;
        }

        .homeCard {
          overflow: hidden;
        }

        .boardList {
          display: grid;
          gap: 10px;
        }

        .boardGameCard {
          background: rgba(10, 14, 20, 0.92);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          padding: 8px 10px 10px;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.015);
          scroll-margin-top: calc(var(--homeStickyTop) + 150px);
        }

        .boardGameCard.searchHit {
          border-color: rgba(70,215,255,0.42);
          box-shadow:
            inset 0 0 0 1px rgba(255,255,255,0.015),
            0 0 0 1px rgba(70,215,255,0.20),
            0 0 20px rgba(70,215,255,0.12);
        }

        .boardHeaderRow {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 300px;
          align-items: center;
          gap: 10px;
          margin-bottom: 6px;
        }

        .boardHeaderLeft {
          font-size: 10px;
          color: #c7cfda;
          opacity: 0.9;
          font-weight: 700;
          letter-spacing: 0.02em;
        }

        .boardHeaderMarkets {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px;
        }

        .boardHeaderCell {
          text-align: center;
          font-size: 9px;
          color: #b3bcc7;
          opacity: 0.85;
          font-weight: 800;
          letter-spacing: 0.08em;
        }

        .boardTeamRow {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 300px;
          gap: 10px;
          align-items: center;
          margin-bottom: 6px;
        }

        .boardTeamRow:last-of-type {
          margin-bottom: 0;
        }

        .boardTeamInfo {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }

        .boardTeamName {
          font-size: 12px;
          font-weight: 800;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .boardMarketGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 6px;
        }

        .boardMarketCell {
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.04);
          color: #edf2f7;
          border-radius: 8px;
          min-height: 38px;
          padding: 5px 4px;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          cursor: pointer;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.015);
        }

        .boardMarketCell:hover {
          background: rgba(255,255,255,0.08);
          border-color: rgba(70,215,255,0.22);
        }

        .boardMainValue {
          font-size: 11px;
          font-weight: 800;
          line-height: 1;
        }

        .boardSubValue {
          margin-top: 3px;
          font-size: 9px;
          color: #9ee3b0;
          line-height: 1;
          min-height: 9px;
        }

        .boardBottomActions {
          display: flex;
          justify-content: center;
          margin-top: 14px;
        }

        @media (max-width: 900px) {
          .logoTitle {
            font-size: 40px;
          }
        }

        @media (max-width: 980px) {
          .boardHeaderRow,
          .boardTeamRow {
            grid-template-columns: minmax(0, 1fr);
          }

          .boardHeaderMarkets,
          .boardMarketGrid {
            width: 100%;
          }
        }

        @media (max-width: 760px) {
          :root {
         --stickyOffset: 0px;

          .appShell {
            padding: 12px;
          }

          .topbar {
            grid-template-columns: 1fr auto;
            padding: 10px 12px;
            border-radius: 20px;
          }

          .twoCol,
          .threeCol {
            grid-template-columns: 1fr;
          }

          .betCard {
            padding: 16px;
            border-radius: 24px;
          }

          .betRowTop {
            grid-template-columns: 1fr;
            gap: 14px;
          }

          .betRight {
            justify-content: flex-start;
          }

          .betRowBottom {
            flex-direction: column;
            gap: 6px;
          }

          .miniBtn,
          .statusPill {
            min-width: 110px;
            height: 48px;
            font-size: 15px;
          }

          .logoTitle {
            font-size: 32px;
          }

          .logoIcon {
            width: 54px;
            height: 54px;
          }

          .logoSub {
            font-size: 11px;
          }

          .homeStickyRow {
            flex-direction: column;
            align-items: stretch;
          }

          .homeStickyMeta {
            white-space: normal;
          }

          .boardGameCard {
            padding: 10px;
          }

          .boardHeaderMarkets,
          .boardMarketGrid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 5px;
          }

          .boardHeaderCell {
            font-size: 8px;
          }

          .boardTeamName {
            font-size: 11px;
          }

          .boardMainValue {
            font-size: 10px;
          }

          .boardSubValue {
            font-size: 8px;
          }

          .boardBetModal {
            max-width: 100%;
            padding: 14px;
          }
        }
      `}</style>

      <div className="appShell">
        <header className="topbar">
          <div className="logoCenterWrap">
            <SettleUpLogo centered />
            <div className="headerGlow" />
          </div>

          <div className="menuWrap" onClick={(e) => e.stopPropagation()}>
            <button className="menuBtn" onClick={() => setMenuOpen((p) => !p)}>
              ☰
            </button>

            {menuOpen && (
              <div className="menuPanel">
                <button onClick={() => goToPage("home")}>Home</button>
                <button onClick={() => goToPage("account")}>My Account</button>
                <button onClick={() => goToPage("mybets")}>My Bets</button>
                <button onClick={() => goToPage("settleup")}>Settle Up</button>
                <button onClick={() => goToPage("history")}>Bet History</button>
                <button onClick={handleLogout}>Logout</button>
              </div>
            )}
          </div>
        </header>

        {showLockedState ? (
          <div className="shellFade">
            {renderSkeletonScreen()}

            {!authLoading && !session && (
              <div className="modalBackdrop">
                <div className="modal authModal">
                  <SettleUpLogo centered small />

                  <h1 className="modalTitle">
                    {authMode === "signup" ? "Create account" : "Sign In"}
                  </h1>

                  <p className="modalCopy">
                    Create an account or sign in to access SettleUp Bet Tracker.
                  </p>

                  <div className="authToggleRow">
                    <button
                      className={authMode === "signup" ? "tabBtn active" : "tabBtn"}
                      onClick={() => {
                        setAuthMode("signup");
                        setAuthError("");
                      }}
                    >
                      Create Account
                    </button>
                    <button
                      className={authMode === "login" ? "tabBtn active" : "tabBtn"}
                      onClick={() => {
                        setAuthMode("login");
                        setAuthError("");
                      }}
                    >
                      Sign In
                    </button>
                  </div>

                  {authMode === "signup" ? (
                    <>
                      <div className="fieldGroup">
                        <label>Username</label>
                        <input
                          value={signupUsername}
                          onChange={(e) => setSignupUsername(e.target.value)}
                          placeholder="Enter username"
                        />
                      </div>

                      <div className="fieldGroup">
                        <label>Email</label>
                        <input
                          value={signupEmail}
                          onChange={(e) => setSignupEmail(e.target.value)}
                          placeholder="Enter email"
                        />
                      </div>

                      <div className="fieldGroup">
                        <label>Password</label>
                        <input
                          type="password"
                          value={signupPassword}
                          onChange={(e) => setSignupPassword(e.target.value)}
                          placeholder="Enter password"
                        />
                      </div>

                      {authError && <div className="msgErr">{authError}</div>}

                      <button className="greenBtn full" style={{ marginTop: 18 }} onClick={handleSignup}>
                        Create Account
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="fieldGroup">
                        <label>Email</label>
                        <input
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          placeholder="Enter email"
                        />
                      </div>

                      <div className="fieldGroup">
                        <label>Password</label>
                        <input
                          type="password"
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          placeholder="Enter password"
                        />
                      </div>

                      {authError && <div className="msgErr">{authError}</div>}

                      <button className="greenBtn full" style={{ marginTop: 18 }} onClick={handleLogin}>
                        Sign In
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className={`shellFade ${pageLoading ? "pageLoading" : ""}`} style={{ overflow: "visible" }}>
            {showCreateBetModal && (
              <div className="modalBackdrop">
                <div className="modal createBetModal">
                  <button
                    className="closeX"
                    onClick={() => {
                      setShowCreateBetModal(false);
                      resetCreateBetModal();
                    }}
                  >
                    ×
                  </button>

                  <SettleUpLogo centered small />
                  <h2 className="modalTitle">Create a Bet</h2>

                  <div className="fieldGroup">
                    <label>Proposed By</label>
                    <input value={currentUser?.username || ""} disabled />
                  </div>

                  <div className="fieldGroup">
                    <label>Select Opponent Username</label>
                    <input
                      value={opponentSearch}
                      onChange={(e) => {
                        setOpponentSearch(e.target.value);
                        setSelectedOpponentId("");
                        setCreateBetError("");
                      }}
                      placeholder="Start typing a username"
                    />
                    {opponentSearch && !selectedOpponentId && (
                      <div className="autocompleteBox">
                        {filteredOpponentOptions.length ? (
                          filteredOpponentOptions.map((user) => (
                            <button
                              key={user.id}
                              className="autocompleteItem"
                              onClick={() => {
                                setSelectedOpponentId(user.id);
                                setOpponentSearch(user.username);
                              }}
                            >
                              {user.username}
                            </button>
                          ))
                        ) : (
                          <div className="smallPad" style={{ color: "#98a1ae" }}>
                            No dropdown match. Exact username text will still work.
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="fieldGroup">
                    <label>Bet Type</label>
                    <div className="radioRow">
                      <button
                        type="button"
                        className={betMode === "classic" ? "radioBtn active" : "radioBtn"}
                        onClick={() => setBetMode("classic")}
                      >
                        Classic Bet
                      </button>
                      <button
                        type="button"
                        className={betMode === "custom" ? "radioBtn active" : "radioBtn"}
                        onClick={() => setBetMode("custom")}
                      >
                        Custom Bet
                      </button>
                    </div>
                  </div>

                  {betMode === "custom" ? (
                    <div className="fieldGroup">
                      <label>Bet Details</label>
                      <textarea
                        value={customBetDetails}
                        onChange={(e) => setCustomBetDetails(e.target.value)}
                        placeholder="Write out the bet"
                      />
                    </div>
                  ) : (
                    <>
                      <div className="twoCol">
                        <div className="fieldGroup">
                          <label>Taking</label>
                          <input
                            value={takingTeam}
                            onChange={(e) => setTakingTeam(e.target.value)}
                            placeholder="Team / side you are taking"
                          />
                        </div>
                        <div className="fieldGroup">
                          <label>Against</label>
                          <input
                            value={againstTeam}
                            onChange={(e) => setAgainstTeam(e.target.value)}
                            placeholder="Team / side you are against"
                          />
                        </div>
                      </div>

                      <div className="fieldGroup">
                        <label>Market</label>
                        <div className="radioRow">
                          <button
                            type="button"
                            className={marketType === "total" ? "radioBtn active" : "radioBtn"}
                            onClick={() => {
                              setMarketType("total");
                              setClassicOdds("+100");
                            }}
                          >
                            Total
                          </button>
                          <button
                            type="button"
                            className={marketType === "side" ? "radioBtn active" : "radioBtn"}
                            onClick={() => {
                              setMarketType("side");
                              if (sidePick !== "ml") setClassicOdds("+100");
                            }}
                          >
                            ML / Spread
                          </button>
                        </div>
                      </div>

                      {marketType === "total" ? (
                        <div className="twoCol">
                          <div className="fieldGroup">
                            <label>Pick</label>
                            <div className="radioRow">
                              <button
                                type="button"
                                className={totalPick === "over" ? "radioBtn active" : "radioBtn"}
                                onClick={() => setTotalPick("over")}
                              >
                                Over
                              </button>
                              <button
                                type="button"
                                className={totalPick === "under" ? "radioBtn active" : "radioBtn"}
                                onClick={() => setTotalPick("under")}
                              >
                                Under
                              </button>
                            </div>
                          </div>
                          <div className="fieldGroup">
                            <label>Number</label>
                            <input
                              value={totalNumber}
                              onChange={(e) =>
                                setTotalNumber(e.target.value.replace(/[^\d.]/g, ""))
                              }
                              placeholder="158"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="twoCol">
                          <div className="fieldGroup">
                            <label>Pick</label>
                            <div className="radioRow">
                              <button
                                type="button"
                                className={sidePick === "ml" ? "radioBtn active" : "radioBtn"}
                                onClick={() => {
                                  setSidePick("ml");
                                }}
                              >
                                ML
                              </button>
                              <button
                                type="button"
                                className={sidePick === "plus" ? "radioBtn active" : "radioBtn"}
                                onClick={() => {
                                  setSidePick("plus");
                                  setClassicOdds("+100");
                                }}
                              >
                                +
                              </button>
                              <button
                                type="button"
                                className={sidePick === "minus" ? "radioBtn active" : "radioBtn"}
                                onClick={() => {
                                  setSidePick("minus");
                                  setClassicOdds("+100");
                                }}
                              >
                                -
                              </button>
                            </div>
                          </div>
                          <div className="fieldGroup">
                            <label>{sidePick === "ml" ? "Line" : "Spread"}</label>
                            <input
                              value={sidePick === "ml" ? "EVEN" : sideNumber}
                              onChange={(e) =>
                                sidePick === "ml"
                                  ? null
                                  : setSideNumber(e.target.value.replace(/[^\d.]/g, ""))
                              }
                              disabled={sidePick === "ml"}
                              placeholder={sidePick === "ml" ? "EVEN" : "7"}
                            />
                          </div>
                        </div>
                      )}

                      <div className="fieldGroup">
                        <label>Odds</label>
                        <div className="moneyInput oddsInput">
                          <span>US</span>
                          <input
                            value={classicOdds}
                            onChange={(e) => handleClassicOddsChange(e.target.value)}
                            onBlur={handleClassicOddsBlur}
                            placeholder="+100"
                          />
                        </div>
                        <div className="helperText">
                          Moneyline uses selected odds. Spread and total are always +100.
                        </div>
                      </div>
                    </>
                  )}

                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>Bet Amount</label>
                      <div className="moneyInput">
                        <span>$</span>
                        <input
                          value={betAmount}
                          onChange={(e) => handleAmountChange(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>

                    <div className="fieldGroup">
                      <label>Win Amount</label>
                      <div className="moneyInput">
                        <span>$</span>
                        <input
                          value={winAmount}
                          onChange={(e) =>
                            betMode === "custom"
                              ? setWinAmount(sanitizeMoneyInput(e.target.value))
                              : null
                          }
                          readOnly={betMode === "classic"}
                          placeholder="0"
                        />
                      </div>
                      {betMode === "classic" && (
                        <div className="helperText">
                          Auto-calculated from your stake and odds.
                        </div>
                      )}
                    </div>
                  </div>

                  {createBetError && <div className="msgErr">{createBetError}</div>}

                  <button className="greenBtn full" style={{ marginTop: 18 }} onClick={handleCreateBet}>
                    Propose Bet
                  </button>
                </div>
              </div>
            )}

            {showBoardBetModal && (
              <div className="modalBackdrop">
                <div className="modal boardBetModal">
                  <button
                    className="closeX"
                    onClick={() => {
                      setShowBoardBetModal(false);
                      resetBoardBetModal();
                    }}
                  >
                    ×
                  </button>

                  <SettleUpLogo centered small />
                  <h2 className="modalTitle">Propose Bet</h2>
                  <p className="modalCopy">Selected from the today classic bet board.</p>

                  <div className="boardSlipMatchup">
                    {boardTakingTeam} vs {boardAgainstTeam}
                  </div>

                  <div className="fieldGroup">
                    <label>Proposed By</label>
                    <input value={currentUser?.username || ""} disabled />
                  </div>

                  <div className="fieldGroup">
                    <label>Select Opponent Username</label>
                    <input
                      value={boardOpponentSearch}
                      onChange={(e) => {
                        setBoardOpponentSearch(e.target.value);
                        setBoardSelectedOpponentId("");
                        setCreateBetError("");
                      }}
                      placeholder="Start typing a username"
                    />
                    {boardOpponentSearch && !boardSelectedOpponentId && (
                      <div className="autocompleteBox">
                        {filteredBoardOpponentOptions.length ? (
                          filteredBoardOpponentOptions.map((user) => (
                            <button
                              key={user.id}
                              className="autocompleteItem"
                              onClick={() => {
                                setBoardSelectedOpponentId(user.id);
                                setBoardOpponentSearch(user.username);
                              }}
                            >
                              {user.username}
                            </button>
                          ))
                        ) : (
                          <div className="smallPad" style={{ color: "#98a1ae" }}>
                            No dropdown match. Exact username text will still work.
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="threeCol">
                    <div className="fieldGroup">
                      <label>Market</label>
                      <input
                        value={
                          boardMarketType === "total"
                            ? "Total"
                            : boardSidePick === "ml"
                            ? "Moneyline"
                            : "Spread"
                        }
                        disabled
                      />
                    </div>

                    {boardMarketType === "total" ? (
                      <>
                        <div className="fieldGroup">
                          <label>Pick</label>
                          <input
                            value={boardTotalPick === "over" ? "Over" : "Under"}
                            disabled
                          />
                        </div>

                        <div className="fieldGroup">
                          <label>Number</label>
                          <input value={boardTotalNumber} disabled />
                        </div>
                      </>
                    ) : boardSidePick === "ml" ? (
                      <>
                        <div className="fieldGroup">
                          <label>Pick</label>
                          <input value="ML" disabled />
                        </div>

                        <div className="fieldGroup">
                          <label>Line</label>
                          <input value="EVEN" disabled />
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="fieldGroup" style={{ gridColumn: "span 2" }}>
                          <label>Spread</label>
                          <input
                            value={formatSignedLine(boardSidePick, boardSideNumber)}
                            disabled
                          />
                        </div>
                      </>
                    )}
                  </div>

                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>Taking Team</label>
                      <input value={boardTakingTeam} disabled />
                    </div>
                    <div className="fieldGroup">
                      <label>Opponent Team</label>
                      <input value={boardAgainstTeam} disabled />
                    </div>
                  </div>

                  <div className="fieldGroup">
                    <label>Odds</label>
                    <div className="moneyInput oddsInput boardLockedInput">
                      <span>US</span>
                      <input value={boardClassicOdds || "+100"} disabled />
                    </div>
                    <div className="helperText">
                      Totals and spreads stay +100. Moneyline uses the real board value.
                    </div>
                  </div>

                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>Bet Amount</label>
                      <div className="moneyInput">
                        <span>$</span>
                        <input
                          value={boardBetAmount}
                          onChange={(e) => handleBoardAmountChange(e.target.value)}
                          placeholder="0"
                        />
                      </div>
                    </div>

                    <div className="fieldGroup">
                      <label>Win Amount</label>
                      <div className="moneyInput">
                        <span>$</span>
                        <input value={boardWinAmount} readOnly placeholder="0" />
                      </div>
                      <div className="helperText">
                        Spread/total win equals stake. Moneyline uses the selected odds.
                      </div>
                    </div>
                  </div>

                  {createBetError && <div className="msgErr">{createBetError}</div>}

                  <button
                    className="greenBtn full"
                    style={{ marginTop: 14 }}
                    onClick={handleCreateBoardBet}
                  >
                    Propose Bet
                  </button>
                </div>
              </div>
            )}

            {page === "home" && (
              <section className="homePage">
                <div className="homeStickyWrap">
                  <div className="homeStickyPanel">
                    <div className="homeStickyRow">
                      <div className="homeStickyUserBlock">
                        <div className="homeStickyEyebrow">Logged in as</div>
                        <div className="homeStickyUser">{currentUser?.username || "User"}</div>
                      </div>

                      <button className="greenBtn" onClick={() => setShowCreateBetModal(true)}>
                        Create Bet
                      </button>
                    </div>

                    <div className="homeStickyRow">
                      <h2 className="homeStickyBoardTitle">Today&apos;s Classic Bet Board</h2>
                      <div className="homeStickyMeta">
                        {todayBoardLoading
                          ? "Loading games..."
                          : `${todayBoard.length} basketball game${todayBoard.length === 1 ? "" : "s"}`}
                      </div>
                    </div>

                    <div className="searchWrap">
                      <input
                        value={boardSearch}
                        onChange={(e) => setBoardSearch(e.target.value)}
                        placeholder="Search by team name to jump to a game"
                      />
                    </div>
                  </div>
                </div>

                <section className="prettyCard homeCard">
                  {todayBoardError ? (
                    <div className="emptyState">{todayBoardError}</div>
                  ) : todayBoardLoading && !todayBoard.length ? (
                    <div className="emptyState">Loading games...</div>
                  ) : !todayBoard.length ? (
                    <div className="emptyState">No games available right now.</div>
                  ) : (
                    <>
                      <div className="boardList">
                        {visibleTodayBoard.map((game, idx) => {
                          const isHit = idx === boardSearchMatchIndex;
                          return (
                            <div
                              key={game.id || idx}
                              ref={(el) => {
                                if (el) gameRefs.current[game.id] = el;
                              }}
                              className={`boardGameCard ${isHit ? "searchHit" : ""}`}
                            >
                              <div className="boardHeaderRow">
                                <div className="boardHeaderLeft">
                                  {game.sportTitle} • {formatBoardTime(game.commenceTime)}
                                </div>

                                <div className="boardHeaderMarkets">
                                  <div className="boardHeaderCell">ML</div>
                                  <div className="boardHeaderCell">SPR</div>
                                  <div className="boardHeaderCell">TOT</div>
                                </div>
                              </div>

                              <div className="boardTeamRow">
                                <div className="boardTeamInfo">
                                  <TeamLogo src={game.awayLogo} name={game.awayTeam} />
                                  <div className="boardTeamName">{game.awayTeam}</div>
                                </div>

                                <div className="boardMarketGrid">
                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.awayTeam,
                                        againstTeam: game.homeTeam,
                                        marketType: "side",
                                        sidePick: "ml",
                                        sideNumber: "EVEN",
                                        odds: game.moneyline?.away || "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">{game.moneyline?.away || "—"}</div>
                                    <div className="boardSubValue">Moneyline</div>
                                  </button>

                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.awayTeam,
                                        againstTeam: game.homeTeam,
                                        marketType: "side",
                                        sidePick: game.spread?.away?.sidePick || "plus",
                                        sideNumber: game.spread?.away?.sideNumber || "",
                                        odds: "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.spread?.away?.sideNumber
                                        ? formatSignedLine(
                                            game.spread.away.sidePick,
                                            game.spread.away.sideNumber
                                          )
                                        : "—"}
                                    </div>
                                    <div className="boardSubValue">+100</div>
                                  </button>

                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.awayTeam,
                                        againstTeam: game.homeTeam,
                                        marketType: "total",
                                        totalPick: "over",
                                        totalNumber: game.total?.number || "",
                                        odds: "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.total?.number ? `O ${game.total.number}` : "—"}
                                    </div>
                                    <div className="boardSubValue">+100</div>
                                  </button>
                                </div>
                              </div>

                              <div className="boardTeamRow">
                                <div className="boardTeamInfo">
                                  <TeamLogo src={game.homeLogo} name={game.homeTeam} />
                                  <div className="boardTeamName">{game.homeTeam}</div>
                                </div>

                                <div className="boardMarketGrid">
                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.homeTeam,
                                        againstTeam: game.awayTeam,
                                        marketType: "side",
                                        sidePick: "ml",
                                        sideNumber: "EVEN",
                                        odds: game.moneyline?.home || "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">{game.moneyline?.home || "—"}</div>
                                    <div className="boardSubValue">Moneyline</div>
                                  </button>

                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.homeTeam,
                                        againstTeam: game.awayTeam,
                                        marketType: "side",
                                        sidePick: game.spread?.home?.sidePick || "minus",
                                        sideNumber: game.spread?.home?.sideNumber || "",
                                        odds: "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.spread?.home?.sideNumber
                                        ? formatSignedLine(
                                            game.spread.home.sidePick,
                                            game.spread.home.sideNumber
                                          )
                                        : "—"}
                                    </div>
                                    <div className="boardSubValue">+100</div>
                                  </button>

                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.homeTeam,
                                        againstTeam: game.awayTeam,
                                        marketType: "total",
                                        totalPick: "under",
                                        totalNumber: game.total?.number || "",
                                        odds: "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.total?.number ? `U ${game.total.number}` : "—"}
                                    </div>
                                    <div className="boardSubValue">+100</div>
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {visibleBoardCount < todayBoard.length && (
                        <div className="boardBottomActions">
                          <button
                            className="ghostBtn"
                            onClick={() =>
                              setVisibleBoardCount((prev) =>
                                Math.min(prev + BOARD_PAGE_SIZE, todayBoard.length)
                              )
                            }
                          >
                            Show 50 More
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>

                <div className="pageGrid" style={{ marginTop: 18 }}>
                  <section className="prettyCard">
                    <div className="pageHeader">
                      <h2>Open Bets Feed</h2>
                    </div>

                    <div className="scrollList">
                      {openBetsFeed.length ? (
                        openBetsFeed.map((bet) => renderBetCard(bet))
                      ) : (
                        <div className="emptyState">No open bets posted right now.</div>
                      )}
                    </div>
                  </section>

                  <section className="prettyCard" style={{ marginTop: 18 }}>
                    <div className="pageHeader">
                      <h2>Leaderboard</h2>
                    </div>

                    <div className="filterRow">
                      {filters.map((filter) => (
                        <button
                          key={filter}
                          className={leaderboardFilter === filter ? "filterBtn active" : "filterBtn"}
                          onClick={() => setLeaderboardFilter(filter)}
                        >
                          {filter}
                        </button>
                      ))}
                    </div>

                    <div className="tableWrap sectionBlock">
                      <table>
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th>Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {leaderboard.length ? (
                            leaderboard.map((row) => (
                              <tr key={row.userId}>
                                <td>{row.username}</td>
                                <td className={row.net >= 0 ? "greenText" : "redText"}>
                                  {currency(row.net)}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan="2" className="emptyCell">
                                No leaderboard data for this filter yet.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </section>
            )}

            {page === "account" && (
              <div className="pageGrid">
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>My Account</h2>
                  </div>

                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>Username</label>
                      <input
                        value={accountUsername}
                        onChange={(e) => setAccountUsername(e.target.value)}
                        placeholder="Username"
                      />
                    </div>

                    <div className="fieldGroup">
                      <label>Email</label>
                      <input
                        value={accountEmail}
                        onChange={(e) => setAccountEmail(e.target.value)}
                        placeholder="Email"
                      />
                    </div>
                  </div>

                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>First Name</label>
                      <input
                        value={accountFirstName}
                        onChange={(e) => setAccountFirstName(e.target.value)}
                        placeholder="First name"
                      />
                    </div>

                    <div className="fieldGroup">
                      <label>Last Name</label>
                      <input
                        value={accountLastName}
                        onChange={(e) => setAccountLastName(e.target.value)}
                        placeholder="Last name"
                      />
                    </div>
                  </div>

                  {accountError && <div className="msgErr">{accountError}</div>}
                  {accountMessage && <div className="msgOk">{accountMessage}</div>}

                  <button
                    className="greenBtn"
                    style={{ marginTop: 18 }}
                    onClick={handleSaveAccount}
                    disabled={savingAccount}
                  >
                    {savingAccount ? "Saving..." : "Save Account"}
                  </button>
                </section>
              </div>
            )}

            {page === "mybets" && (
              <div className="pageGrid">
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>My Bets</h2>
                  </div>

                  <div className="sectionBlock">
                    <h3>Proposed by Me</h3>
                    <div className="scrollList">
                      {myProposedBets.length ? (
                        myProposedBets.map((bet) => renderBetCard(bet, { showDelete: true }))
                      ) : (
                        <div className="emptyState">No bets proposed by you right now.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Proposed to Me</h3>
                    <div className="scrollList">
                      {proposedToMe.length ? (
                        proposedToMe.map((bet) =>
                          renderBetCard(bet, { showAcceptDecline: true })
                        )
                      ) : (
                        <div className="emptyState">No bets waiting on you right now.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Open Bets</h3>
                    <div className="scrollList">
                      {pendingBets.length ? (
                        pendingBets.map((bet) => renderBetCard(bet, { showGrade: true }))
                      ) : (
                        <div className="emptyState">No open bets right now.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Awaiting Payment</h3>
                    <div className="scrollList">
                      {unpaidGradedBets.length ? (
                        unpaidGradedBets.map((bet) =>
                          renderBetCard(bet, { showPayment: true })
                        )
                      ) : (
                        <div className="emptyState">No graded unpaid bets right now.</div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}

            {page === "settleup" && (
              <div className="pageGrid">
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>Settle Up</h2>
                  </div>

                  <div className="tableWrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Player</th>
                          <th>Net</th>
                          <th className="settleCtaCell">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {outstanding.length ? (
                          outstanding.map((row) => (
                            <tr key={row.userId}>
                              <td>{row.username}</td>
                              <td className={row.net >= 0 ? "greenText" : "redText"}>
                                {currency(row.net)}
                              </td>
                              <td className="settleCtaCell">
                                <button
                                  className="greenBtn settleInlineBtn"
                                  onClick={() => settleAllWithUser(row.userId)}
                                >
                                  Settle All
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : (
                          <tr>
                            <td colSpan="3" className="emptyCell">
                              Nothing to settle right now.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            )}

            {page === "history" && (
              <div className="pageGrid">
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>Bet History</h2>
                  </div>

                  <div className="filterRow">
                    {filters.map((filter) => (
                      <button
                        key={filter}
                        className={historyFilter === filter ? "filterBtn active" : "filterBtn"}
                        onClick={() => setHistoryFilter(filter)}
                      >
                        {filter}
                      </button>
                    ))}
                  </div>

                  <div className="sectionBlock">
                    <h3>Head to Head</h3>
                    <div className="tableWrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th>Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {headToHead.length ? (
                            headToHead.map((row) => (
                              <tr key={row.userId}>
                                <td>{row.username}</td>
                                <td className={row.net >= 0 ? "greenText" : "redText"}>
                                  {currency(row.net)}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan="2" className="emptyCell">
                                No history for this filter yet.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Settled Bets</h3>
                    <div className="scrollList">
                      {paidHistory.filter((bet) =>
                        isInFilter(bet.updatedAt || bet.createdAt, historyFilter)
                      ).length ? (
                        paidHistory
                          .filter((bet) => isInFilter(bet.updatedAt || bet.createdAt, historyFilter))
                          .map((bet) => renderBetCard(bet))
                      ) : (
                        <div className="emptyState">No settled bets in this filter.</div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}    