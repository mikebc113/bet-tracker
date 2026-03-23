import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";

const filters = ["Day", "Month", "Year", "All Time"];
const TODAY_BOARD_CACHE_KEY = "settleup_today_board_cache_v6";
const PAGE_STORAGE_KEY = "settleup_active_page_v1";
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

function isChopBet(bet) {
  return bet?.proposerGrade === "chop" && bet?.acceptorGrade === "chop";
}

function getBetDisplayStatus(bet) {
  if (bet.status === "proposed") return "Waiting";
  if (bet.status === "declined") return "Declined";
  if (bet.status === "accepted") return "Open";
  if (bet.status === "graded") {
    if (isChopBet(bet)) return "Chop";
    return "Awaiting payment";
  }
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

  if (
    !Number.isFinite(bet) ||
    bet <= 0 ||
    !Number.isFinite(line) ||
    line === 0
  ) {
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

function readTodayBoardCache() {
  const cached = safeJsonParse(localStorage.getItem(TODAY_BOARD_CACHE_KEY));
  if (!cached || !Array.isArray(cached.items) || !cached.date) return null;
  return cached;
}

function writeTodayBoardCache(date, items) {
  localStorage.setItem(
    TODAY_BOARD_CACHE_KEY,
    JSON.stringify({
      date,
      items,
    })
  );
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
    detail =
      payload.sidePick === "ml" ? "Classic • Moneyline" : "Classic • Spread";
  }

  return `${proposerName} vs ${acceptorName} • ${detail}`;
}

function isValidFinalPair(mine, theirs) {
  return (
    (mine === "win" && theirs === "loss") ||
    (mine === "loss" && theirs === "win") ||
    (mine === "chop" && theirs === "chop")
  );
}

function isConflictPair(mine, theirs) {
  if (!mine || !theirs) return false;
  return !isValidFinalPair(mine, theirs);
}

function gradeLabelForViewer(bet, currentUserId) {
  const mine =
    bet.proposerId === currentUserId ? bet.proposerGrade : bet.acceptorGrade;
  const theirs =
    bet.proposerId === currentUserId ? bet.acceptorGrade : bet.proposerGrade;

  if (!mine) return "Choose Win, Loss, or Chop";

  if (!theirs) {
    return `WAITING FOR OPPONENT GRADE • YOU PICKED ${String(mine).toUpperCase()}`;
  }

  if (mine === "chop" && theirs === "chop") {
    return "BOTH PLAYERS SELECTED CHOP";
  }

  if (isConflictPair(mine, theirs)) {
    return `GRADE CONFLICT • YOU: ${String(mine).toUpperCase()} • OPPONENT: ${String(theirs).toUpperCase()}`;
  }

  return `YOU: ${String(mine).toUpperCase()} • OPPONENT: ${String(theirs).toUpperCase()}`;
}

function getLeaderboard(users, bets, filter) {
  const totals = users.map((user) => {
    const relevant = bets.filter(
      (b) =>
        (b.status === "graded" || b.status === "settled") &&
        !isChopBet(b) &&
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
      isChopBet(bet) ||
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
      map.set(otherUserId, {
        userId: otherUserId,
        username: otherName,
        net: 0,
      });
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
    if (isChopBet(bet)) return;
    if (bet.proposerId !== currentUserId && bet.acceptorId !== currentUserId) {
      return;
    }

    const otherUserId =
      bet.proposerId === currentUserId ? bet.acceptorId : bet.proposerId;
    const otherName = getUserName(users, otherUserId);

    if (!map.has(otherUserId)) {
      map.set(otherUserId, {
        userId: otherUserId,
        username: otherName,
        net: 0,
      });
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
    <div
      className={`logoWrap ${centered ? "centered" : ""} ${small ? "small" : ""}`}
    >
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

          <circle
            cx="60"
            cy="60"
            r="44"
            fill="none"
            stroke="url(#suBlueGreen)"
            strokeWidth="8"
            opacity="0.95"
          />
          <path
            d="M25 40c8-14 23-24 40-24"
            stroke="#46D7FF"
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M93 76c-7 16-22 28-42 28"
            stroke="#A7E15F"
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
          />
          <path d="M68 13l10 5-11 8" fill="#46D7FF" />
          <path d="M54 109l-10-5 11-8" fill="#A7E15F" />

          <ellipse cx="50" cy="58" rx="14" ry="6" fill="url(#suCoin)" />
          <rect x="36" y="58" width="28" height="8" fill="url(#suCoin)" />
          <ellipse cx="50" cy="66" rx="14" ry="6" fill="url(#suCoin)" />

          <ellipse cx="70" cy="49" rx="14" ry="6" fill="url(#suCoin)" />
          <rect x="56" y="49" width="28" height="8" fill="url(#suCoin)" />
          <ellipse cx="70" cy="57" rx="14" ry="6" fill="url(#suCoin)" />

          <path
            d="M78 77l8 8 18-24"
            fill="none"
            stroke="#A7E15F"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <rect
            x="80"
            y="34"
            width="18"
            height="24"
            rx="3"
            fill="#F7FBFF"
            opacity="0.95"
          />
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
    item?.leagues?.[0]?.name,
    item?.leagues?.[0]?.abbreviation,
    item?.season?.type?.name,
    item?.shortName,
    item?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    joined.includes("basketball") ||
    joined.includes("ncaab") ||
    joined.includes("ncaa") ||
    joined.includes("mens college basketball") ||
    joined.includes("women's college basketball")
  );
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function extractEspnCompetition(item) {
  return item?.competitions?.[0] || null;
}

function extractEspnCompetitor(item, side) {
  const competition = extractEspnCompetition(item);
  if (!competition?.competitors) return null;

  return (
    competition.competitors.find((competitor) => {
      const homeAway = String(competitor?.homeAway || "").toLowerCase();
      return homeAway === side;
    }) || null
  );
}

function getTeamLogoFromEspn(item, side) {
  const competitor = extractEspnCompetitor(item, side);
  const logo = competitor?.team?.logo || competitor?.team?.logos?.[0]?.href;
  return logo || "";
}

function getTeamNameFromEspn(item, side) {
  const competitor = extractEspnCompetitor(item, side);
  return (
    competitor?.team?.displayName ||
    competitor?.team?.shortDisplayName ||
    competitor?.team?.name ||
    ""
  );
}

function extractTeamScore(item, side) {
  const direct = firstDefined(
    item?.[`${side}_score`],
    item?.[`${side}Score`],
    item?.scores?.[side],
    item?.score?.[side]
  );
  if (direct !== "") return String(direct);

  const espnCompetitor = extractEspnCompetitor(item, side);
  if (
    espnCompetitor?.score !== undefined &&
    espnCompetitor?.score !== null &&
    espnCompetitor?.score !== ""
  ) {
    return String(espnCompetitor.score);
  }

  const targetName =
    side === "home"
      ? item.home_team || item.homeTeam || getTeamNameFromEspn(item, "home")
      : item.away_team || item.awayTeam || getTeamNameFromEspn(item, "away");

  const outcomes = item?.scores?.outcomes || item?.score?.outcomes;
  if (Array.isArray(outcomes)) {
    const match = outcomes.find(
      (outcome) =>
        normalizeTeamName(outcome?.name) === normalizeTeamName(targetName)
    );
    if (
      match?.score !== undefined &&
      match?.score !== null &&
      match?.score !== ""
    ) {
      return String(match.score);
    }
  }

  return "";
}

function extractGameStatus(item) {
  const competition = extractEspnCompetition(item);
  const statusType = competition?.status?.type || item?.status?.type || null;

  const completedRaw = firstDefined(
    statusType?.completed,
    item?.completed,
    item?.is_completed,
    item?.final,
    item?.isFinal,
    item?.status === "completed",
    item?.status === "final"
  );

  const completed = Boolean(completedRaw);
  const stateName = String(statusType?.name || "").toLowerCase();

  if (completed || stateName === "status_final" || stateName === "final") {
    return {
      isLive: false,
      isFinal: true,
      statusText: "Final",
    };
  }

  const clock = firstDefined(
    competition?.status?.type?.shortDetail,
    competition?.status?.detail,
    competition?.status?.displayClock,
    item?.display_clock,
    item?.displayClock,
    item?.clock,
    item?.time_remaining,
    item?.timeRemaining,
    item?.status_detail,
    item?.statusDetail,
    item?.status_text,
    item?.statusText,
    item?.short_detail,
    item?.shortDetail,
    item?.game_status,
    item?.gameStatus
  );

  if (clock) {
    const normalized = String(clock).trim();
    const lower = normalized.toLowerCase();

    if (lower.includes("final") || lower.includes("ft") || lower.includes("ended")) {
      return {
        isLive: false,
        isFinal: true,
        statusText: "Final",
      };
    }

    if (
      lower.includes("pregame") ||
      lower.includes("scheduled") ||
      lower.includes("today") ||
      lower.includes("tonight")
    ) {
      return {
        isLive: false,
        isFinal: false,
        statusText: normalized,
      };
    }

    return {
      isLive: true,
      isFinal: false,
      statusText: normalized,
    };
  }

  return {
    isLive: false,
    isFinal: false,
    statusText: "",
  };
}

function extractMoneyline(item) {
  const homeTeam =
    item.home_team || item.homeTeam || getTeamNameFromEspn(item, "home");
  const awayTeam =
    item.away_team || item.awayTeam || getTeamNameFromEspn(item, "away");

  const h2hMarket = findMarket(item?.bookmakers, "h2h");

  const homeOutcome =
    h2hMarket?.outcomes?.find(
      (o) =>
        o.name === homeTeam ||
        normalizeTeamName(o.name) === normalizeTeamName(homeTeam)
    ) || null;

  const awayOutcome =
    h2hMarket?.outcomes?.find(
      (o) =>
        o.name === awayTeam ||
        normalizeTeamName(o.name) === normalizeTeamName(awayTeam)
    ) || null;

  const homeRaw = firstDefined(
    item?.home_moneyline,
    item?.homeMoneyline,
    item?.ml_home,
    item?.home_ml,
    item?.moneyline_home,
    item?.moneylineHome,
    item?.odds?.moneyline?.home,
    homeOutcome?.price
  );

  const awayRaw = firstDefined(
    item?.away_moneyline,
    item?.awayMoneyline,
    item?.ml_away,
    item?.away_ml,
    item?.moneyline_away,
    item?.moneylineAway,
    item?.odds?.moneyline?.away,
    awayOutcome?.price
  );

  return {
    home: formatOddsForDisplay(homeRaw),
    away: formatOddsForDisplay(awayRaw),
  };
}

function extractSpread(item) {
  const homeTeam =
    item.home_team || item.homeTeam || getTeamNameFromEspn(item, "home");
  const awayTeam =
    item.away_team || item.awayTeam || getTeamNameFromEspn(item, "away");

  const spreadMarket = findMarket(item?.bookmakers, "spreads");

  const homeOutcome =
    spreadMarket?.outcomes?.find(
      (o) =>
        o.name === homeTeam ||
        normalizeTeamName(o.name) === normalizeTeamName(homeTeam)
    ) || null;

  const awayOutcome =
    spreadMarket?.outcomes?.find(
      (o) =>
        o.name === awayTeam ||
        normalizeTeamName(o.name) === normalizeTeamName(awayTeam)
    ) || null;

  let homePoint = toNumberOrBlank(
    firstDefined(
      item?.home_spread,
      item?.homeSpread,
      item?.spread_home,
      item?.spreadHome,
      item?.home_spread_points,
      item?.homeSpreadPoints,
      item?.odds?.spread?.home,
      homeOutcome?.point
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
      awayOutcome?.point
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

  const overOutcome =
    totalMarket?.outcomes?.find(
      (o) => String(o.name || "").toLowerCase() === "over"
    ) || null;

  const underOutcome =
    totalMarket?.outcomes?.find(
      (o) => String(o.name || "").toLowerCase() === "under"
    ) || null;

  const point = firstDefined(
    item?.total,
    item?.total_points,
    item?.totalPoints,
    item?.over_under,
    item?.overUnder,
    item?.odds?.total?.number,
    overOutcome?.point,
    underOutcome?.point
  );

  return {
    number: point === "" ? "" : String(point),
    overOdds: "+100",
    underOdds: "+100",
  };
}

function extractBoardItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.games)) return data.games;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.board)) return data.board;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.combined)) return data.combined;
  if (Array.isArray(data?.odds)) return data.odds;

  const firstArrayValue = Object.values(data || {}).find((value) =>
    Array.isArray(value)
  );

  return Array.isArray(firstArrayValue) ? firstArrayValue : [];
}

function normalizeBoardGames(items, options = {}) {
  const { includeStarted = false } = options;
  const basketballItems = items.filter((item) => isBasketballItem(item));
  const grouped = new Map();

  basketballItems.forEach((item) => {
    const homeTeam =
      item.home_team || item.homeTeam || getTeamNameFromEspn(item, "home") || "Home";
    const awayTeam =
      item.away_team || item.awayTeam || getTeamNameFromEspn(item, "away") || "Away";
    const commenceTime = item.commence_time || item.commenceTime || "";
    const key = `${homeTeam}__${awayTeam}__${commenceTime}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        homeTeam,
        awayTeam,
        homeLogo: "",
        awayLogo: "",
        sportTitle: item.sport_title || item.sportTitle || "Basketball",
        commenceTime,
        moneyline: { home: "", away: "" },
        spread: {
          home: { sidePick: "plus", sideNumber: "", odds: "+100" },
          away: { sidePick: "plus", sideNumber: "", odds: "+100" },
        },
        total: {
          number: "",
          overOdds: "+100",
          underOdds: "+100",
        },
        homeScore: "",
        awayScore: "",
        isLive: false,
        isFinal: false,
        statusText: "",
      });
    }

    const game = grouped.get(key);
    const selectedTeam = item.selectedTeam || "";
    const marketType = item.marketType;
    const odds = formatOddsForDisplay(item.odds);

    const awayLogo =
      getTeamLogoFromItem(item, "away") || getTeamLogoFromEspn(item, "away");
    const homeLogo =
      getTeamLogoFromItem(item, "home") || getTeamLogoFromEspn(item, "home");

    if (!game.awayLogo && awayLogo) game.awayLogo = awayLogo;
    if (!game.homeLogo && homeLogo) game.homeLogo = homeLogo;

    const awayScore = extractTeamScore(item, "away");
    const homeScore = extractTeamScore(item, "home");
    if (awayScore !== "") game.awayScore = awayScore;
    if (homeScore !== "") game.homeScore = homeScore;

    const status = extractGameStatus(item);
    if (status.statusText || status.isLive || status.isFinal) {
      game.isLive = status.isLive;
      game.isFinal = status.isFinal;
      game.statusText = status.statusText;
    }

    if (marketType === "side" && item.sidePick === "ml") {
      if (normalizeTeamName(selectedTeam) === normalizeTeamName(homeTeam)) {
        game.moneyline.home = odds;
      }
      if (normalizeTeamName(selectedTeam) === normalizeTeamName(awayTeam)) {
        game.moneyline.away = odds;
      }
    }

    if (marketType === "side" && item.sidePick !== "ml") {
      const spreadData = {
        sidePick: item.sidePick || "plus",
        sideNumber:
          item.sideNumber !== null && item.sideNumber !== undefined
            ? String(Math.abs(Number(item.sideNumber)))
            : "",
        odds: "+100",
      };

      if (normalizeTeamName(selectedTeam) === normalizeTeamName(homeTeam)) {
        game.spread.home = spreadData;
      }

      if (normalizeTeamName(selectedTeam) === normalizeTeamName(awayTeam)) {
        game.spread.away = spreadData;
      }
    }

    if (marketType === "total") {
      if (item.totalNumber !== null && item.totalNumber !== undefined) {
        game.total.number = String(item.totalNumber);
      }
    }

    if (!game.moneyline.home || !game.moneyline.away) {
      const ml = extractMoneyline(item);
      if (!game.moneyline.home && ml.home) game.moneyline.home = ml.home;
      if (!game.moneyline.away && ml.away) game.moneyline.away = ml.away;
    }

    if (!game.spread.home.sideNumber || !game.spread.away.sideNumber) {
      const spread = extractSpread(item);
      if (!game.spread.home.sideNumber && spread.home.sideNumber) {
        game.spread.home = spread.home;
      }
      if (!game.spread.away.sideNumber && spread.away.sideNumber) {
        game.spread.away = spread.away;
      }
    }

    if (!game.total.number) {
      const total = extractTotal(item);
      if (total.number) game.total = total;
    }
  });

  const now = Date.now();

  return Array.from(grouped.values())
    .filter((game) => {
      if (includeStarted) return true;
      if (!game.commenceTime) return true;
      const startTime = new Date(game.commenceTime).getTime();
      if (Number.isNaN(startTime)) return true;
      return startTime > now;
    })
    .sort((a, b) => {
      return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
    });
}

function findGameForBet(payload, games) {
  if (!payload || payload.kind !== "classic" || !Array.isArray(games) || !games.length) {
    return null;
  }

  const teamA = normalizeTeamName(payload.takingTeam);
  const teamB = normalizeTeamName(payload.againstTeam);

  return (
    games.find((game) => {
      const home = normalizeTeamName(game.homeTeam);
      const away = normalizeTeamName(game.awayTeam);

      return (
        (teamA === home && teamB === away) ||
        (teamA === away && teamB === home)
      );
    }) || null
  );
}

function getBetGameDisplay(bet, currentUserId, games) {
  const payload = getPayloadForViewer(bet, currentUserId);
  const game = findGameForBet(payload, games);

  if (!game) return null;

  const hasScores = game.homeScore !== "" || game.awayScore !== "";
  const scoreText = hasScores
    ? `${game.awayTeam} ${game.awayScore || "0"} - ${game.homeTeam} ${game.homeScore || "0"}`
    : `${game.awayTeam} vs ${game.homeTeam}`;

  let stateText = "";
  if (game.isFinal) stateText = "Final";
  else if (game.isLive && game.statusText) stateText = game.statusText;
  else if (game.statusText) stateText = game.statusText;
  else stateText = formatBoardTime(game.commenceTime);

  return {
    scoreText,
    stateText,
    isFinal: game.isFinal,
    isLive: game.isLive,
  };
}

export default function App() {
  const [users, setUsers] = useState([]);
  const [bets, setBets] = useState([]);
  const [session, setSession] = useState(null);

  const [authLoading, setAuthLoading] = useState(true);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [betsLoading, setBetsLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);

  const [page, setPage] = useState(() => {
    if (typeof window === "undefined") return "home";
    return localStorage.getItem(PAGE_STORAGE_KEY) || "home";
  });
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
  const [boardTakingLogo, setBoardTakingLogo] = useState("");
  const [boardAgainstLogo, setBoardAgainstLogo] = useState("");
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
  const [allTodayGames, setAllTodayGames] = useState([]);
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
      users.find(
        (u) => u.email?.toLowerCase() === (authUser.email || "").toLowerCase()
      );

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

  const myBets = useMemo(() => {
    if (!currentUser) return [];
    return bets.filter(
      (b) =>
        b &&
        (b.proposerId === currentUser.id || b.acceptorId === currentUser.id)
    );
  }, [bets, currentUser]);

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

  const otherUsers = useMemo(
    () => users.filter((u) => u.id !== currentUser?.id),
    [users, currentUser]
  );

  const filteredOpponentOptions = useMemo(() => {
    const query = opponentSearch.trim().toLowerCase();
    if (!query) return [];
    return otherUsers.filter((u) =>
      u.username.toLowerCase().includes(query)
    );
  }, [otherUsers, opponentSearch]);

  const filteredBoardOpponentOptions = useMemo(() => {
    const query = boardOpponentSearch.trim().toLowerCase();
    if (!query) return [];
    return otherUsers.filter((u) =>
      u.username.toLowerCase().includes(query)
    );
  }, [otherUsers, boardOpponentSearch]);

  const openBetsFeed = useMemo(
    () => myBets.filter((b) => b.status === "accepted"),
    [myBets]
  );

  const leaderboard = useMemo(
    () => getLeaderboard(users, bets, leaderboardFilter),
    [users, bets, leaderboardFilter]
  );

  const myProposedBets = useMemo(
    () =>
      myBets.filter(
        (b) => currentUser && b.proposerId === currentUser.id && b.status === "proposed"
      ),
    [myBets, currentUser]
  );

  const proposedToMe = useMemo(
    () =>
      myBets.filter(
        (b) => currentUser && b.acceptorId === currentUser.id && b.status === "proposed"
      ),
    [myBets, currentUser]
  );

  const pendingBets = useMemo(
    () =>
      myBets.filter((b) => currentUser && b.status === "accepted"),
    [myBets, currentUser]
  );

  const unpaidGradedBets = useMemo(
    () =>
      myBets.filter(
        (b) =>
          currentUser &&
          b.status === "graded" &&
          !isChopBet(b)
      ),
    [myBets, currentUser]
  );

  const paidHistory = useMemo(
    () =>
      myBets.filter(
        (b) =>
          currentUser &&
          (b.status === "settled" ||
            (b.status === "graded" && isChopBet(b)))
      ),
    [myBets, currentUser]
  );

  const outstanding = useMemo(
    () =>
      currentUser ? getOutstandingBalances(currentUser.id, users, bets) : [],
    [currentUser, users, bets]
  );

  const headToHead = useMemo(
    () =>
      currentUser
        ? getHeadToHeadTotals(currentUser.id, users, bets, historyFilter)
        : [],
    [currentUser, users, bets, historyFilter]
  );

  useEffect(() => {
    localStorage.setItem(PAGE_STORAGE_KEY, page);
  }, [page]);

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
    const configuredBoardUrl =
      import.meta.env.VITE_COMBINED_ODDS_ENDPOINT ||
      (import.meta.env.DEV
        ? "http://localhost:4001/api/combined-odds"
        : "/api/combined-odds");

    const todayKey = getTodayKey();
    const cached = readTodayBoardCache();

    if (cached?.date === todayKey && Array.isArray(cached.items) && cached.items.length) {
      const allGames = normalizeBoardGames(cached.items, { includeStarted: true });
      const boardGames = normalizeBoardGames(cached.items, { includeStarted: false });

      setAllTodayGames(allGames);
      setTodayBoard(boardGames);
      setVisibleBoardCount(BOARD_PAGE_SIZE);
    }

    let cancelled = false;

    async function loadTodayBoardOnce() {
      setTodayBoardLoading(true);
      setTodayBoardError("");

      try {
        const response = await fetch(configuredBoardUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Board request failed: ${response.status}`);
        }

        const data = await response.json();
        const items = extractBoardItems(data);
        const allGames = normalizeBoardGames(items, { includeStarted: true });
        const boardGames = normalizeBoardGames(items, { includeStarted: false });

        if (!cancelled) {
          if (allGames.length) {
            setAllTodayGames(allGames);
            setTodayBoard(boardGames);
            setVisibleBoardCount(BOARD_PAGE_SIZE);
            writeTodayBoardCache(todayKey, items);
            setTodayBoardError("");
          } else if (cached?.items?.length) {
            const cachedAllGames = normalizeBoardGames(cached.items, { includeStarted: true });
            const cachedBoardGames = normalizeBoardGames(cached.items, { includeStarted: false });

            setAllTodayGames(cachedAllGames);
            setTodayBoard(cachedBoardGames);
            setTodayBoardError("");
          } else {
            setAllTodayGames([]);
            setTodayBoard([]);
            setTodayBoardError("Could not load today's board.");
          }
        }
      } catch {
        if (!cancelled) {
          if (cached?.items?.length) {
            const cachedAllGames = normalizeBoardGames(cached.items, { includeStarted: true });
            const cachedBoardGames = normalizeBoardGames(cached.items, { includeStarted: false });

            setAllTodayGames(cachedAllGames);
            setTodayBoard(cachedBoardGames);
            setTodayBoardError("");
          } else {
            setAllTodayGames([]);
            setTodayBoard([]);
            setTodayBoardError("Could not load today's board.");
          }
        }
      } finally {
        if (!cancelled) {
          setTodayBoardLoading(false);
        }
      }
    }

    loadTodayBoardOnce();

    return () => {
      cancelled = true;
    };
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
      const mappedBets = data
        .map(mapDbBetToUi)
        .filter(
          (bet) =>
            bet &&
            authUser &&
            (bet.proposerId === authUser.id || bet.acceptorId === authUser.id)
        );

      setBets(mappedBets);
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
    if (!authUser) return;

    const channel = supabase
      .channel("bets-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "bets" },
        async () => {
          await loadBets();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
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
    setBoardTakingLogo("");
    setBoardAgainstLogo("");
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
        odds: sidePick === "ml" ? classicOdds : "+100",
      }),
    };
  }

  function getBoardCreateBetPayload() {
    if (boardMarketType === "total") {
      if (!boardTakingTeam.trim() || !boardAgainstTeam.trim()) {
        return { error: "Enter both teams." };
      }

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

    if (!boardTakingTeam.trim() || !boardAgainstTeam.trim()) {
      return { error: "Enter both teams." };
    }

    const oddsValue = oddsToNumber(boardClassicOdds);
    if (!Number.isFinite(oddsValue) || Math.abs(oddsValue) > 10000) {
      return { error: "Enter valid odds between -10000 and +10000." };
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
        sideNumber: boardSidePick === "ml" ? "EVEN" : boardSideNumber.trim(),
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

  async function updateBetRow(betId, patch) {
    const dbPatch = {};

    if ("status" in patch) dbPatch.status = patch.status;
    if ("proposerGrade" in patch) dbPatch.proposer_grade = patch.proposerGrade;
    if ("acceptorGrade" in patch) dbPatch.acceptor_grade = patch.acceptorGrade;
    if ("proposerPaid" in patch) dbPatch.proposer_paid = patch.proposerPaid;
    if ("acceptorPaid" in patch) dbPatch.acceptor_paid = patch.acceptorPaid;
    if ("updatedAt" in patch) dbPatch.updated_at = patch.updatedAt;

    const { error } = await supabase.from("bets").update(dbPatch).eq("id", betId);
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

    const timestamp = getNow();
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const error = await persistNewBet(newBet);

    if (error) {
      setCreateBetError("Could not create bet.");
      return;
    }

    setBets((prev) => [newBet, ...prev]);
    setShowCreateBetModal(false);
    resetCreateBetModal();

    setPage("mybets");
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

    const timestamp = getNow();
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
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const error = await persistNewBet(newBet);

    if (error) {
      setCreateBetError("Could not create bet.");
      return;
    }

    setBets((prev) => [newBet, ...prev]);
    setShowBoardBetModal(false);
    resetBoardBetModal();

    setPage("mybets");
    setPageLoading(true);
    setTimeout(() => setPageLoading(false), 250);
  }

  async function deleteBet(betId) {
    const { error } = await supabase.from("bets").delete().eq("id", betId);
    if (error) return;
    setBets((prev) => prev.filter((b) => !(!b || b.id === betId)));
  }

  async function acceptBet(betId) {
    const updatedAt = getNow();

    const error = await updateBetRow(betId, {
      status: "accepted",
      proposerGrade: null,
      acceptorGrade: null,
      updatedAt,
    });

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

    const error = await updateBetRow(betId, {
      status: "declined",
      updatedAt,
    });

    if (error) return;

    setBets((prev) =>
      prev.map((b) => (b.id === betId ? { ...b, status: "declined", updatedAt } : b))
    );
  }

  async function gradeBet(betId, result) {
    if (!currentUser) return;

    const selectedBet = bets.find((b) => b.id === betId);
    if (!selectedBet || selectedBet.status !== "accepted") return;

    const isProposer = selectedBet.proposerId === currentUser.id;
    const otherGrade = isProposer
      ? selectedBet.acceptorGrade
      : selectedBet.proposerGrade;

    const nextProposerGrade = isProposer ? result : selectedBet.proposerGrade;
    const nextAcceptorGrade = isProposer ? selectedBet.acceptorGrade : result;

    const updatedAt = getNow();

    if (!otherGrade) {
      const error = await updateBetRow(betId, {
        proposerGrade: nextProposerGrade,
        acceptorGrade: nextAcceptorGrade,
        status: "accepted",
        updatedAt,
      });

      if (error) return;

      setBets((prev) =>
        prev.map((b) =>
          b.id === betId
            ? {
                ...b,
                proposerGrade: nextProposerGrade,
                acceptorGrade: nextAcceptorGrade,
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

    if (isValidFinalPair(nextProposerGrade, nextAcceptorGrade)) {
      const error = await updateBetRow(betId, {
        proposerGrade: nextProposerGrade,
        acceptorGrade: nextAcceptorGrade,
        status: "graded",
        updatedAt,
      });

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

      return;
    }

    const error = await updateBetRow(betId, {
      proposerGrade: nextProposerGrade,
      acceptorGrade: nextAcceptorGrade,
      status: "accepted",
      updatedAt,
    });

    if (error) return;

    setBets((prev) =>
      prev.map((b) =>
        b.id === betId
          ? {
              ...b,
              proposerGrade: nextProposerGrade,
              acceptorGrade: nextAcceptorGrade,
              status: "accepted",
              updatedAt,
            }
          : b
      )
    );

    setGradeWarnings((prev) => ({ ...prev, [betId]: true }));
  }

  async function autoFinalizeCompletedGames() {
    if (!allTodayGames.length) return;

    const candidates = bets.filter((bet) => {
      if (bet.status !== "accepted") return false;
      if (!bet.betPayload || bet.betPayload.kind !== "classic") return false;

      const game = findGameForBet(bet.betPayload, allTodayGames);
      return game?.isFinal;
    });

    for (const bet of candidates) {
      const game = findGameForBet(bet.betPayload, allTodayGames);
      if (!game) continue;

      const homeScore = Number(game.homeScore);
      const awayScore = Number(game.awayScore);

      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;

      const payload = bet.betPayload;
      let proposerResult = null;
      let acceptorResult = null;

      const proposerTeamNormalized = normalizeTeamName(payload.takingTeam);
      const homeNormalized = normalizeTeamName(game.homeTeam);
      const awayNormalized = normalizeTeamName(game.awayTeam);

      const proposerIsHome = proposerTeamNormalized === homeNormalized;
      const proposerIsAway = proposerTeamNormalized === awayNormalized;
      if (!proposerIsHome && !proposerIsAway) continue;

      const proposerScore = proposerIsHome ? homeScore : awayScore;
      const opponentScore = proposerIsHome ? awayScore : homeScore;

      if (payload.marketType === "side") {
        if (payload.sidePick === "ml") {
          if (proposerScore === opponentScore) continue;
          proposerResult = proposerScore > opponentScore ? "win" : "loss";
        } else {
          const spreadValue = Number(payload.sideNumber);
          if (!Number.isFinite(spreadValue)) continue;

          const signedSpread =
            payload.sidePick === "minus" ? -spreadValue : spreadValue;
          const adjusted = proposerScore + signedSpread;

          if (adjusted === opponentScore) {
            proposerResult = "chop";
          } else {
            proposerResult = adjusted > opponentScore ? "win" : "loss";
          }
        }
      }

      if (payload.marketType === "total") {
        const totalLine = Number(payload.totalNumber);
        if (!Number.isFinite(totalLine)) continue;

        const totalScore = homeScore + awayScore;
        if (totalScore === totalLine) {
          proposerResult = "chop";
        } else if (payload.totalPick === "over") {
          proposerResult = totalScore > totalLine ? "win" : "loss";
        } else {
          proposerResult = totalScore < totalLine ? "win" : "loss";
        }
      }

      if (!proposerResult) continue;

      acceptorResult =
        proposerResult === "win"
          ? "loss"
          : proposerResult === "loss"
          ? "win"
          : "chop";

      const updatedAt = getNow();
      const error = await updateBetRow(bet.id, {
        proposerGrade: proposerResult,
        acceptorGrade: acceptorResult,
        status: "graded",
        updatedAt,
      });

      if (error) continue;

      setBets((prev) =>
        prev.map((row) =>
          row.id === bet.id
            ? {
                ...row,
                proposerGrade: proposerResult,
                acceptorGrade: acceptorResult,
                status: "graded",
                updatedAt,
              }
            : row
        )
      );
    }
  }

  useEffect(() => {
    autoFinalizeCompletedGames();
  }, [allTodayGames, bets]);

  async function settleBet(betId) {
    const updatedAt = getNow();

    const error = await updateBetRow(betId, {
      proposerPaid: true,
      acceptorPaid: true,
      status: "settled",
      updatedAt,
    });

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

    const rows = bets.filter(
      (b) =>
        b.status === "graded" &&
        !isChopBet(b) &&
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
      <div className="errorText compactError strongMessage">
        Opponent picked something different. Pick a matching opposite result, or both choose chop for a chop.
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
    setBoardTakingLogo(selection.takingLogo || "");
    setBoardAgainstLogo(selection.againstLogo || "");
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
    const gameDisplay = getBetGameDisplay(bet, currentUser.id, allTodayGames);

    return (
      <div key={bet.id} className="betCard">
        <div className="betGlow" />
        <div className="betRowTop">
          <div className="betLeft">
            <div className="betTitle">{headline}</div>
            <div className="betSub">{subline}</div>
            {gameDisplay && (
              <div className="liveGameMeta">
                <div className="liveGameScore">{gameDisplay.scoreText}</div>
                <div className={`liveGameState ${gameDisplay.isLive ? "live" : ""}`}>
                  {gameDisplay.isLive ? "LIVE • " : ""}
                  {gameDisplay.stateText}
                </div>
              </div>
            )}
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
                <button className="ghostBtn miniBtn" onClick={() => gradeBet(bet.id, "chop")}>
                  Chop
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
            <div className="softText compactMeta strongMessage">
              {gradeLabelForViewer(bet, currentUser.id)}
            </div>
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
    authLoading || (session && (profilesLoading || betsLoading));

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
          --homeStickyTop: var(--topbarHeight);
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
          padding: 0 12px 12px 12px;
          background:
            radial-gradient(circle at top, rgba(70,215,255,0.08), transparent 28%),
            radial-gradient(circle at bottom, rgba(167,225,95,0.10), transparent 26%),
            linear-gradient(180deg, #07090d 0%, #0b1018 45%, #05070a 100%);
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
          margin: 0 auto 0 auto;
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
          transform: translateZ(0);
        }

        .topbar::after {
          content: "";
          position: absolute;
          left: 0;
          right: 0;
          bottom: -20px;
          height: 24px;
          background: rgba(9,13,20,0.98);
          pointer-events: none;
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
        .lineTag,
        .menuActionBtn {
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
        .lineTag,
        .menuActionBtn {
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
          color: #edf2f7;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
        }

        .ghostBtn:hover,
        .filterBtn:hover,
        .tabBtn:hover,
        .radioBtn:hover,
        .menuActionBtn:hover {
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
          max-width: 520px;
          max-height: min(84vh, 760px);
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

        .searchWrap {
          margin-top: 0;
          padding-top: 8px;
          border-top: 1px solid rgba(255,255,255,0.06);
          position: relative;
          z-index: 1;
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

        .liveGameMeta {
          margin-top: 10px;
          display: grid;
          gap: 4px;
        }

        .liveGameScore {
          font-size: 15px;
          font-weight: 900;
          color: #f4f7fb;
        }

        .liveGameState {
          font-size: 12px;
          font-weight: 800;
          color: var(--muted);
          letter-spacing: 0.03em;
        }

        .liveGameState.live {
          color: #9ee3b0;
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

        .boardSlipHeader {
          margin-top: 10px;
          padding: 12px;
          border-radius: 18px;
          background: rgba(255,255,255,0.035);
          border: 1px solid rgba(255,255,255,0.08);
        }

        .boardSlipTeams {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          text-align: center;
          font-size: 16px;
          font-weight: 900;
          flex-wrap: wrap;
        }

        .boardSlipVs {
          color: var(--muted);
          font-size: 12px;
          font-weight: 800;
          letter-spacing: 0.08em;
        }

        .boardSlipDetailGrid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-top: 12px;
        }

        .boardSlipDetailCard {
          padding: 12px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.035);
        }

        .boardSlipDetailCardLabel {
          color: var(--muted);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.08em;
          margin-bottom: 6px;
          text-transform: uppercase;
        }

        .boardSlipDetailCardValue {
          font-size: 16px;
          font-weight: 900;
        }

        .strongMessage {
          font-size: 14px;
          font-weight: 900;
          letter-spacing: 0.02em;
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
          margin-top: -20px;
          margin-bottom: 12px;
          border-radius: 28px;
          border: 1px solid rgba(255,255,255,0.08);
          box-shadow: 0 18px 40px rgba(0,0,0,0.34);
          overflow: hidden;
          isolation: isolate;
          background:
            radial-gradient(circle at top left, rgba(70,215,255,0.08), transparent 24%),
            radial-gradient(circle at bottom center, rgba(167,225,95,0.06), transparent 22%),
            linear-gradient(180deg, rgba(13,17,24,0.99), rgba(7,10,15,1));
        }

        .homeStickyWrap::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(circle at 10% 12%, rgba(70,215,255,0.10), transparent 14%),
            radial-gradient(circle at 90% 86%, rgba(167,225,95,0.10), transparent 18%);
          opacity: 0.5;
          z-index: 0;
        }

        .homeStickyPanel {
          position: relative;
          z-index: 1;
          display: grid;
          gap: 0;
          padding: 12px 16px;
          background: rgba(8,12,18,0.98);
        }

        .homeStickyRow {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 7px 0;
        }

        .homeStickyRow + .homeStickyRow {
          border-top: 1px solid rgba(255,255,255,0.06);
        }

        .homeStickyUserBlock {
          min-width: 0;
        }

        .homeStickyEyebrow {
          color: var(--muted);
          font-size: 11px;
          margin-bottom: 3px;
        }

        .homeStickyUser {
          font-size: 15px;
          font-weight: 800;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .homeStickyBoardTitle {
          font-size: 18px;
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
          gap: 8px;
        }

        .boardGameCard {
          background: rgba(10, 14, 20, 0.92);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 14px;
          padding: 7px 9px 8px;
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
          margin-bottom: 5px;
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
          margin-bottom: 5px;
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

        .boardScore {
          margin-left: auto;
          font-size: 13px;
          font-weight: 900;
          color: #f4f7fb;
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
          min-height: 36px;
          padding: 4px 4px;
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

        @media (max-width: 860px) {
          .boardHeaderRow,
          .boardTeamRow {
            grid-template-columns: 1fr;
          }

          .boardHeaderMarkets,
          .boardMarketGrid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }

          .boardScore {
            margin-left: 0;
          }

          .boardSlipDetailGrid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 760px) {
          :root {
            --stickyOffset: 0px;
            --topbarHeight: 88px;
            --homeStickyTop: var(--topbarHeight);
          }

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
        <div className="topbar">
          <div className="logoCenterWrap">
            <SettleUpLogo centered small />
            <div className="headerGlow" />
          </div>

          <div className="menuWrap">
            <button
              className="menuBtn"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((prev) => !prev);
              }}
            >
              ☰
            </button>

            {menuOpen && (
              <div className="menuPanel">
                <button onClick={() => goToPage("home")}>Home</button>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    resetCreateBetModal();
                    setShowCreateBetModal(true);
                  }}
                >
                  Create Bet
                </button>
                <button onClick={() => goToPage("mybets")}>My Bets</button>
                <button onClick={() => goToPage("leaderboard")}>Leaderboard</button>
                <button onClick={() => goToPage("history")}>History</button>
                <button onClick={() => goToPage("settle")}>Settle Up</button>
                <button onClick={() => goToPage("account")}>Account</button>
                <button onClick={handleLogout}>Logout</button>
              </div>
            )}
          </div>
        </div>

        <div className={`pageGrid ${pageLoading ? "" : "shellFade"}`}>
          {showLockedState ? (
            renderSkeletonScreen()
          ) : (
            <>
              {page === "home" && (
                <section className="homePage">
                  <div className="homeStickyWrap">
                    <div className="homeStickyPanel">
                      <div className="homeStickyRow">
                        <div className="homeStickyUserBlock">
                          <div className="homeStickyEyebrow">Logged in</div>
                          <div className="homeStickyUser">{currentUser?.username}</div>
                        </div>
                      </div>

                      <div className="homeStickyRow">
                        <h2 className="homeStickyBoardTitle">
                          Today’s Classic Bet Board
                        </h2>
                        <div className="homeStickyMeta">
                          {todayBoardLoading
                            ? "Loading games..."
                            : todayBoardError
                            ? todayBoardError
                            : `${todayBoard.length} games`}
                        </div>
                      </div>

                      <div className="searchWrap">
                        <input
                          placeholder="Search by team…"
                          value={boardSearch}
                          onChange={(e) => setBoardSearch(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>

                  <section className="prettyCard homeCard">
                    <div className="boardList">
                      {todayBoardLoading && (
                        <div className="emptyState">Loading games…</div>
                      )}

                      {!todayBoardLoading && todayBoardError && (
                        <div className="emptyState">{todayBoardError}</div>
                      )}

                      {!todayBoardLoading &&
                        !todayBoardError &&
                        visibleTodayBoard.length === 0 && (
                          <div className="emptyState">
                            No basketball games available right now.
                          </div>
                        )}

                      {!todayBoardLoading &&
                        !todayBoardError &&
                        visibleTodayBoard.map((game) => {
                          const isSearchHit =
                            boardSearch &&
                            todayBoard.findIndex(
                              (g) =>
                                g.id === game.id &&
                                `${g.awayTeam} ${g.homeTeam}`
                                  .toLowerCase()
                                  .includes(boardSearch.trim().toLowerCase())
                            ) === boardSearchMatchIndex;

                          return (
                            <div
                              key={game.id}
                              ref={(el) => {
                                if (el) gameRefs.current[game.id] = el;
                              }}
                              className={`boardGameCard ${
                                isSearchHit ? "searchHit" : ""
                              }`}
                            >
                              <div className="boardHeaderRow">
                                <div className="boardHeaderLeft">
                                  {formatBoardTime(game.commenceTime)} {game.statusText}
                                </div>
                                <div className="boardHeaderMarkets">
                                  <div className="boardHeaderCell">ML</div>
                                  <div className="boardHeaderCell">SPREAD</div>
                                  <div className="boardHeaderCell">TOTAL</div>
                                </div>
                              </div>

                              <div className="boardTeamRow">
                                <div className="boardTeamInfo">
                                  <TeamLogo src={game.awayLogo} name={game.awayTeam} />
                                  <div className="boardTeamName">{game.awayTeam}</div>
                                  {game.awayScore !== "" && (
                                    <div className="boardScore">{game.awayScore}</div>
                                  )}
                                </div>

                                <div className="boardMarketGrid">
                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.awayTeam,
                                        againstTeam: game.homeTeam,
                                        takingLogo: game.awayLogo,
                                        againstLogo: game.homeLogo,
                                        marketType: "side",
                                        sidePick: "ml",
                                        sideNumber: "EVEN",
                                        odds: game.moneyline.away,
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.moneyline.away || "—"}
                                    </div>
                                  </button>

                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.awayTeam,
                                        againstTeam: game.homeTeam,
                                        takingLogo: game.awayLogo,
                                        againstLogo: game.homeLogo,
                                        marketType: "side",
                                        sidePick: game.spread.away.sidePick,
                                        sideNumber: game.spread.away.sideNumber,
                                        odds: "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.spread.away.sideNumber
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
                                        takingLogo: game.awayLogo,
                                        againstLogo: game.homeLogo,
                                        marketType: "total",
                                        totalPick: "over",
                                        totalNumber: game.total.number,
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.total.number ? `O ${game.total.number}` : "—"}
                                    </div>
                                    <div className="boardSubValue">+100</div>
                                  </button>
                                </div>
                              </div>

                              <div className="boardTeamRow">
                                <div className="boardTeamInfo">
                                  <TeamLogo src={game.homeLogo} name={game.homeTeam} />
                                  <div className="boardTeamName">{game.homeTeam}</div>
                                  {game.homeScore !== "" && (
                                    <div className="boardScore">{game.homeScore}</div>
                                  )}
                                </div>

                                <div className="boardMarketGrid">
                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.homeTeam,
                                        againstTeam: game.awayTeam,
                                        takingLogo: game.homeLogo,
                                        againstLogo: game.awayLogo,
                                        marketType: "side",
                                        sidePick: "ml",
                                        sideNumber: "EVEN",
                                        odds: game.moneyline.home,
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.moneyline.home || "—"}
                                    </div>
                                  </button>

                                  <button
                                    className="boardMarketCell"
                                    onClick={() =>
                                      openBoardBetModal({
                                        takingTeam: game.homeTeam,
                                        againstTeam: game.awayTeam,
                                        takingLogo: game.homeLogo,
                                        againstLogo: game.awayLogo,
                                        marketType: "side",
                                        sidePick: game.spread.home.sidePick,
                                        sideNumber: game.spread.home.sideNumber,
                                        odds: "+100",
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.spread.home.sideNumber
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
                                        takingLogo: game.homeLogo,
                                        againstLogo: game.awayLogo,
                                        marketType: "total",
                                        totalPick: "under",
                                        totalNumber: game.total.number,
                                      })
                                    }
                                  >
                                    <div className="boardMainValue">
                                      {game.total.number ? `U ${game.total.number}` : "—"}
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
                          Show 50 more
                        </button>
                      </div>
                    )}
                  </section>
                </section>
              )}

              {page === "mybets" && (
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>My Bets</h2>
                  </div>

                  <div className="sectionBlock">
                    <h3>My Proposals</h3>
                    <div className="scrollList">
                      {myProposedBets.length === 0 && (
                        <div className="emptyState">No outgoing bets.</div>
                      )}
                      {myProposedBets.map((bet) =>
                        renderBetCard(bet, { showDelete: true })
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Proposed to Me</h3>
                    <div className="scrollList">
                      {proposedToMe.length === 0 && (
                        <div className="emptyState">No incoming bets.</div>
                      )}
                      {proposedToMe.map((bet) =>
                        renderBetCard(bet, { showAcceptDecline: true })
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Accepted and Live</h3>
                    <div className="scrollList">
                      {pendingBets.length === 0 && (
                        <div className="emptyState">No open bets.</div>
                      )}
                      {pendingBets.map((bet) => renderBetCard(bet, { showGrade: true }))}
                    </div>
                  </div>
                </section>
              )}

              {page === "leaderboard" && (
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>Leaderboard</h2>
                  </div>

                  <div className="filterRow">
                    {filters.map((f) => (
                      <button
                        key={f}
                        className={`filterBtn ${leaderboardFilter === f ? "active" : ""}`}
                        onClick={() => setLeaderboardFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  <div className="tableWrap">
                    <table>
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {leaderboard.length === 0 && (
                          <tr>
                            <td colSpan={2} className="emptyCell">
                              No results.
                            </td>
                          </tr>
                        )}
                        {leaderboard.map((row) => (
                          <tr key={row.userId}>
                            <td>{row.username}</td>
                            <td className={row.net >= 0 ? "greenText" : "redText"}>
                              {currency(row.net)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {page === "history" && (
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>History</h2>
                  </div>

                  <div className="filterRow">
                    {filters.map((f) => (
                      <button
                        key={f}
                        className={`filterBtn ${historyFilter === f ? "active" : ""}`}
                        onClick={() => setHistoryFilter(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>

                  <div className="sectionBlock">
                    <h3>Head to Head</h3>
                    <div className="tableWrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Opponent</th>
                            <th>Net</th>
                          </tr>
                        </thead>
                        <tbody>
                          {headToHead.length === 0 && (
                            <tr>
                              <td colSpan={2} className="emptyCell">
                                No history.
                              </td>
                            </tr>
                          )}
                          {headToHead.map((row) => (
                            <tr key={row.userId}>
                              <td>{row.username}</td>
                              <td className={row.net >= 0 ? "greenText" : "redText"}>
                                {currency(row.net)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Settled / Chopped Bets</h3>
                    <div className="scrollList">
                      {paidHistory.filter((bet) =>
                        isInFilter(bet.updatedAt || bet.createdAt, historyFilter)
                      ).length === 0 && (
                        <div className="emptyState">No history yet.</div>
                      )}
                      {paidHistory
                        .filter((bet) =>
                          isInFilter(bet.updatedAt || bet.createdAt, historyFilter)
                        )
                        .map((bet) => renderBetCard(bet))}
                    </div>
                  </div>
                </section>
              )}

              {page === "settle" && (
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>Settle Up</h2>
                  </div>

                  <div className="sectionBlock">
                    <h3>Outstanding</h3>
                    <div className="tableWrap">
                      <table>
                        <thead>
                          <tr>
                            <th>User</th>
                            <th>Net</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {outstanding.length === 0 && (
                            <tr>
                              <td colSpan={3} className="emptyCell">
                                All settled.
                              </td>
                            </tr>
                          )}
                          {outstanding.map((row) => (
                            <tr key={row.userId}>
                              <td>{row.username}</td>
                              <td className={row.net >= 0 ? "greenText" : "redText"}>
                                {currency(row.net)}
                              </td>
                              <td className="settleCtaCell">
                                <button
                                  className="greenBtn miniBtn settleInlineBtn"
                                  onClick={() => settleAllWithUser(row.userId)}
                                >
                                  Settle All
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Awaiting Payment</h3>
                    <div className="scrollList">
                      {unpaidGradedBets.length === 0 && (
                        <div className="emptyState">None.</div>
                      )}
                      {unpaidGradedBets.map((bet) =>
                        renderBetCard(bet, { showPayment: true })
                      )}
                    </div>
                  </div>
                </section>
              )}

              {page === "account" && (
                <section className="prettyCard">
                  <div className="pageHeader">
                    <h2>Account</h2>
                  </div>

                  <div className="fieldGroup">
                    <label>Username</label>
                    <input
                      value={accountUsername}
                      onChange={(e) => setAccountUsername(e.target.value)}
                    />
                  </div>

                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>First Name</label>
                      <input
                        value={accountFirstName}
                        onChange={(e) => setAccountFirstName(e.target.value)}
                      />
                    </div>
                    <div className="fieldGroup">
                      <label>Last Name</label>
                      <input
                        value={accountLastName}
                        onChange={(e) => setAccountLastName(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="fieldGroup">
                    <label>Email</label>
                    <input
                      value={accountEmail}
                      onChange={(e) => setAccountEmail(e.target.value)}
                    />
                  </div>

                  <div className="sectionBlock">
                    <button
                      className="greenBtn"
                      onClick={handleSaveAccount}
                      disabled={savingAccount}
                    >
                      Save
                    </button>
                  </div>

                  {accountMessage && <div className="msgOk">{accountMessage}</div>}
                  {accountError && <div className="msgErr">{accountError}</div>}
                </section>
              )}
            </>
          )}
        </div>

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

              <h2 className="modalTitle">Create Bet</h2>

              <div className="fieldGroup">
                <label>Opponent</label>
                <input
                  placeholder="Search username"
                  value={opponentSearch}
                  onChange={(e) => {
                    setOpponentSearch(e.target.value);
                    setSelectedOpponentId("");
                  }}
                />
                {opponentSearch.trim().length > 0 && filteredOpponentOptions.length > 0 && (
                  <div className="autocompleteBox">
                    {filteredOpponentOptions.map((u) => (
                      <button
                        key={u.id}
                        className="autocompleteItem"
                        onClick={() => {
                          setSelectedOpponentId(u.id);
                          setOpponentSearch(u.username);
                        }}
                      >
                        {u.username}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="fieldGroup">
                <label>Mode</label>
                <div className="radioRow">
                  <button
                    type="button"
                    className={`radioBtn ${betMode === "classic" ? "active" : ""}`}
                    onClick={() => setBetMode("classic")}
                  >
                    Classic
                  </button>
                  <button
                    type="button"
                    className={`radioBtn ${betMode === "custom" ? "active" : ""}`}
                    onClick={() => setBetMode("custom")}
                  >
                    Custom
                  </button>
                </div>
              </div>

              {betMode === "custom" ? (
                <div className="fieldGroup">
                  <label>Details</label>
                  <textarea
                    value={customBetDetails}
                    onChange={(e) => setCustomBetDetails(e.target.value)}
                  />
                </div>
              ) : (
                <>
                  <div className="twoCol">
                    <div className="fieldGroup">
                      <label>Taking Team</label>
                      <input
                        value={takingTeam}
                        onChange={(e) => setTakingTeam(e.target.value)}
                      />
                    </div>
                    <div className="fieldGroup">
                      <label>Against</label>
                      <input
                        value={againstTeam}
                        onChange={(e) => setAgainstTeam(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="fieldGroup">
                    <label>Market</label>
                    <div className="radioRow">
                      <button
                        type="button"
                        className={`radioBtn ${marketType === "side" ? "active" : ""}`}
                        onClick={() => setMarketType("side")}
                      >
                        Side
                      </button>
                      <button
                        type="button"
                        className={`radioBtn ${marketType === "total" ? "active" : ""}`}
                        onClick={() => setMarketType("total")}
                      >
                        Total
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
                            className={`radioBtn ${totalPick === "over" ? "active" : ""}`}
                            onClick={() => setTotalPick("over")}
                          >
                            Over
                          </button>
                          <button
                            type="button"
                            className={`radioBtn ${totalPick === "under" ? "active" : ""}`}
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
                          onChange={(e) => setTotalNumber(e.target.value)}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="fieldGroup">
                        <label>Pick</label>
                        <div className="radioRow">
                          <button
                            type="button"
                            className={`radioBtn ${sidePick === "ml" ? "active" : ""}`}
                            onClick={() => setSidePick("ml")}
                          >
                            ML
                          </button>
                          <button
                            type="button"
                            className={`radioBtn ${sidePick === "plus" ? "active" : ""}`}
                            onClick={() => setSidePick("plus")}
                          >
                            +
                          </button>
                          <button
                            type="button"
                            className={`radioBtn ${sidePick === "minus" ? "active" : ""}`}
                            onClick={() => setSidePick("minus")}
                          >
                            -
                          </button>
                        </div>
                      </div>

                      {sidePick !== "ml" && (
                        <div className="fieldGroup">
                          <label>Spread</label>
                          <input
                            value={sideNumber}
                            onChange={(e) => setSideNumber(e.target.value)}
                          />
                        </div>
                      )}

                      {sidePick === "ml" && (
                        <div className="fieldGroup">
                          <label>Odds</label>
                          <input
                            value={classicOdds}
                            onChange={(e) => handleClassicOddsChange(e.target.value)}
                            onBlur={handleClassicOddsBlur}
                          />
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              <div className="twoCol">
                <div className="fieldGroup">
                  <label>Bet</label>
                  <div className="moneyInput">
                    <span>$</span>
                    <input
                      value={betAmount}
                      onChange={(e) => handleAmountChange(e.target.value)}
                    />
                  </div>
                </div>

                <div className="fieldGroup">
                  <label>To Win</label>
                  <div className="moneyInput">
                    <span>$</span>
                    <input value={winAmount} readOnly />
                  </div>
                </div>
              </div>

              <div className="sectionBlock">
                <button className="greenBtn full" onClick={handleCreateBet}>
                  Send Bet
                </button>
              </div>

              {createBetError && <div className="errorText">{createBetError}</div>}
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

              <h2 className="modalTitle">Create Bet</h2>

              <div className="boardSlipHeader">
                <div className="boardSlipTeams">
                  <TeamLogo src={boardTakingLogo} name={boardTakingTeam} />
                  <span>{boardTakingTeam}</span>
                  <span className="boardSlipVs">VS</span>
                  <TeamLogo src={boardAgainstLogo} name={boardAgainstTeam} />
                  <span>{boardAgainstTeam}</span>
                </div>

                {boardMarketType !== "total" && (
                  <div className="boardSlipDetailGrid">
                    <div className="boardSlipDetailCard">
                      <div className="boardSlipDetailCardLabel">Taking</div>
                      <div className="boardSlipDetailCardValue">
                        {boardTakingTeam}
                      </div>
                    </div>

                    <div className="boardSlipDetailCard">
                      <div className="boardSlipDetailCardLabel">Against</div>
                      <div className="boardSlipDetailCardValue">
                        {boardAgainstTeam}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="fieldGroup">
                <label>Opponent</label>
                <input
                  placeholder="Search username"
                  value={boardOpponentSearch}
                  onChange={(e) => {
                    setBoardOpponentSearch(e.target.value);
                    setBoardSelectedOpponentId("");
                  }}
                />
                {boardOpponentSearch.trim().length > 0 &&
                  filteredBoardOpponentOptions.length > 0 && (
                    <div className="autocompleteBox">
                      {filteredBoardOpponentOptions.map((u) => (
                        <button
                          key={u.id}
                          className="autocompleteItem"
                          onClick={() => {
                            setBoardSelectedOpponentId(u.id);
                            setBoardOpponentSearch(u.username);
                          }}
                        >
                          {u.username}
                        </button>
                      ))}
                    </div>
                  )}
              </div>

              {boardMarketType === "side" && boardSidePick === "ml" && (
                <div className="boardSlipDetailGrid">
                  <div className="boardSlipDetailCard">
                    <div className="boardSlipDetailCardLabel">Odds Type</div>
                    <div className="boardSlipDetailCardValue">ML</div>
                  </div>

                  <div className="boardSlipDetailCard">
                    <div className="boardSlipDetailCardLabel">Odds</div>
                    <div className="boardSlipDetailCardValue">{boardClassicOdds}</div>
                  </div>
                </div>
              )}

              {boardMarketType === "side" && boardSidePick !== "ml" && (
                <div className="boardSlipDetailGrid">
                  <div className="boardSlipDetailCard">
                    <div className="boardSlipDetailCardLabel">Spread</div>
                    <div className="boardSlipDetailCardValue">
                      {formatSignedLine(boardSidePick, boardSideNumber)}
                    </div>
                  </div>

                  <div className="boardSlipDetailCard">
                    <div className="boardSlipDetailCardLabel">Odds</div>
                    <div className="boardSlipDetailCardValue">+100</div>
                  </div>
                </div>
              )}

              {boardMarketType === "total" && (
                <div className="boardSlipDetailGrid">
                  <div className="boardSlipDetailCard">
                    <div className="boardSlipDetailCardLabel">Total</div>
                    <div className="boardSlipDetailCardValue">
                      {(boardTotalPick === "over" ? "O " : "U ") + boardTotalNumber}
                    </div>
                  </div>

                  <div className="boardSlipDetailCard">
                    <div className="boardSlipDetailCardLabel">Odds</div>
                    <div className="boardSlipDetailCardValue">+100</div>
                  </div>
                </div>
              )}

              <div className="twoCol">
                <div className="fieldGroup">
                  <label>Bet</label>
                  <div className="moneyInput">
                    <span>$</span>
                    <input
                      value={boardBetAmount}
                      onChange={(e) => handleBoardAmountChange(e.target.value)}
                    />
                  </div>
                </div>

                <div className="fieldGroup">
                  <label>To Win</label>
                  <div className="moneyInput">
                    <span>$</span>
                    <input value={boardWinAmount} readOnly />
                  </div>
                </div>
              </div>

              <div className="sectionBlock">
                <button className="greenBtn full" onClick={handleCreateBoardBet}>
                  Propose Bet
                </button>
              </div>

              {createBetError && <div className="errorText">{createBetError}</div>}
            </div>
          </div>
        )}

        {!session && !authLoading && (
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
    </>
  );
}          