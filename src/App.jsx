import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

const STORAGE_KEYS = {
  users: "bet_tracker_users",
};

const defaultUsers = [
  { id: "u1", name: "Mike", email: "mike@test.com", password: "123456" },
  { id: "u2", name: "Mandy", email: "mandy@test.com", password: "123456" },
  { id: "u3", name: "Steve", email: "steve@test.com", password: "123456" },
];

const filters = ["Day", "Month", "Year", "All Time"];

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function currency(value) {
  const num = Number(value || 0);
  const abs = Math.abs(num).toLocaleString();
  return num < 0 ? `-$${abs}` : `$${abs}`;
}

function getNow() {
  return new Date().toISOString();
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

function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function getUserName(users, userId) {
  return users.find((u) => u.id === userId)?.name || "Unknown";
}

function getBetDisplayStatus(bet) {
  if (bet.status === "proposed") return "Waiting";
  if (bet.status === "declined") return "Declined";
  if (bet.status === "accepted") return "Open";
  if (bet.status === "graded") return "Awaiting payment";
  if (bet.status === "settled") return "Settled";
  return bet.status;
}

function getOpenFeedBets(bets) {
  return bets.filter((b) => b.status === "accepted");
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
  };
}

function serializeBetPayload(payload) {
  return JSON.stringify(payload);
}

function parseBetPayload(text) {
  const parsed = safeJsonParse(text);

  if (parsed && parsed.version === 2 && parsed.kind) {
    return parsed;
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

  if (payload.marketType === "total") {
    return `${payload.takingTeam} vs ${payload.againstTeam} • ${
      payload.totalPick === "over" ? "Over" : "Under"
    } ${payload.totalNumber}`;
  }

  if (payload.marketType === "side") {
    if (payload.sidePick === "ml") {
      return `${payload.takingTeam} ML vs ${payload.againstTeam}`;
    }

    const sign = payload.sidePick === "plus" ? "+" : "-";
    return `${payload.takingTeam} ${sign}${payload.sideNumber} vs ${payload.againstTeam}`;
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
    detail = "Classic • ML/Spread";
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

    return { userId: user.id, name: user.name, net };
  });

  return totals.sort((a, b) => b.net - a.net);
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
      map.set(otherUserId, { userId: otherUserId, name: otherName, net: 0 });
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
    if (bet.proposerPaid && bet.acceptorPaid) return;
    if (bet.proposerId !== currentUserId && bet.acceptorId !== currentUserId) {
      return;
    }

    const otherUserId =
      bet.proposerId === currentUserId ? bet.acceptorId : bet.proposerId;
    const otherName = getUserName(users, otherUserId);

    if (!map.has(otherUserId)) {
      map.set(otherUserId, { userId: otherUserId, name: otherName, net: 0 });
    }

    const item = map.get(otherUserId);
    const winAmount = Number(bet.winAmount || 0);
    const stake = Number(bet.amount || 0);

    if (bet.proposerGrade === "win" && bet.acceptorGrade === "loss") {
      if (bet.proposerId === currentUserId && !bet.proposerPaid) item.net += winAmount;
      if (bet.acceptorId === currentUserId && !bet.acceptorPaid) item.net -= stake;
    }

    if (bet.proposerGrade === "loss" && bet.acceptorGrade === "win") {
      if (bet.acceptorId === currentUserId && !bet.acceptorPaid) item.net += winAmount;
      if (bet.proposerId === currentUserId && !bet.proposerPaid) item.net -= stake;
    }
  });

  return Array.from(map.values()).sort((a, b) => b.net - a.net);
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

export default function App() {
  const [users, setUsers] = useState(() =>
    loadLocal(STORAGE_KEYS.users, defaultUsers)
  );
  const [bets, setBets] = useState([]);
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);

  const [page, setPage] = useState("home");
  const [menuOpen, setMenuOpen] = useState(false);

  const [showAuthModal, setShowAuthModal] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [authError, setAuthError] = useState("");

  const [signupName, setSignupName] = useState("");
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");

  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");

  const [showCreateBetModal, setShowCreateBetModal] = useState(false);
  const [createBetError, setCreateBetError] = useState("");

  const [opponentSearch, setOpponentSearch] = useState("");
  const [selectedOpponentId, setSelectedOpponentId] = useState("");

  const [betMode, setBetMode] = useState("classic");
  const [customBetDetails, setCustomBetDetails] = useState("");

  const [takingTeam, setTakingTeam] = useState("");
  const [againstTeam, setAgainstTeam] = useState("");
  const [marketType, setMarketType] = useState("side");
  const [totalPick, setTotalPick] = useState("over");
  const [totalNumber, setTotalNumber] = useState("");
  const [sidePick, setSidePick] = useState("ml");
  const [sideNumber, setSideNumber] = useState("");

  const [betAmount, setBetAmount] = useState("");
  const [winAmount, setWinAmount] = useState("");

  const [leaderboardFilter, setLeaderboardFilter] = useState("All Time");
  const [historyFilter, setHistoryFilter] = useState("All Time");
  const [isLoadingBets, setIsLoadingBets] = useState(true);

  const [gradeWarnings, setGradeWarnings] = useState({});

  const authUser = session?.user || null;

  const currentUser = useMemo(() => {
    if (authUser) {
      const localMatch =
        users.find((u) => u.id === authUser.id) ||
        users.find((u) => u.email.toLowerCase() === (authUser.email || "").toLowerCase());

      return (
        localMatch || {
          id: authUser.id,
          name:
            authUser.user_metadata?.name ||
            authUser.email?.split("@")[0] ||
            "User",
          email: authUser.email || "",
        }
      );
    }

    return users[0] || { id: "guest", name: "Guest", email: "" };
  }, [authUser, users]);

  useEffect(() => {
    saveLocal(STORAGE_KEYS.users, users);
  }, [users]);

  useEffect(() => {
    async function initAuth() {
      const { data } = await supabase.auth.getSession();
      setSession(data.session || null);
      setShowAuthModal(!data.session);
      setAuthLoading(false);
    }

    initAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession || null);
      setShowAuthModal(!nextSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const handleClick = () => setMenuOpen(false);
    if (menuOpen) window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [menuOpen]);

  async function loadBetsFromSupabase() {
    if (!supabase) return;

    setIsLoadingBets(true);

    const { data, error } = await supabase
      .from("bets")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && data) {
      setBets(data.map(mapDbBetToUi));
    }

    setIsLoadingBets(false);
  }

  useEffect(() => {
    loadBetsFromSupabase();
  }, []);

  useEffect(() => {
    if (!authUser) return;

    setUsers((prev) => {
      const exists =
        prev.some((u) => u.id === authUser.id) ||
        prev.some((u) => u.email.toLowerCase() === (authUser.email || "").toLowerCase());

      if (exists) {
        return prev.map((u) => {
          if (u.id === authUser.id || u.email.toLowerCase() === (authUser.email || "").toLowerCase()) {
            return {
              ...u,
              id: authUser.id,
              email: authUser.email || u.email,
              name: authUser.user_metadata?.name || u.name,
            };
          }
          return u;
        });
      }

      return [
        ...prev,
        {
          id: authUser.id,
          name:
            authUser.user_metadata?.name ||
            authUser.email?.split("@")[0] ||
            "User",
          email: authUser.email || "",
        },
      ];
    });
  }, [authUser]);

  const otherUsers = users.filter((u) => u.id !== currentUser.id);

  const filteredOpponentOptions = otherUsers.filter((u) =>
    u.name.toLowerCase().includes(opponentSearch.toLowerCase())
  );

  const openBetsFeed = useMemo(() => getOpenFeedBets(bets), [bets]);

  const leaderboard = useMemo(
    () => getLeaderboard(users, bets, leaderboardFilter),
    [users, bets, leaderboardFilter]
  );

  const myProposedBets = bets.filter(
    (b) => b.proposerId === currentUser.id && b.status === "proposed"
  );

  const proposedToMe = bets.filter(
    (b) => b.acceptorId === currentUser.id && b.status === "proposed"
  );

  const pendingBets = bets.filter(
    (b) =>
      (b.proposerId === currentUser.id || b.acceptorId === currentUser.id) &&
      b.status === "accepted"
  );

  const unpaidGradedBets = bets.filter(
    (b) =>
      (b.proposerId === currentUser.id || b.acceptorId === currentUser.id) &&
      b.status === "graded" &&
      !(b.proposerPaid && b.acceptorPaid)
  );

  const paidHistory = bets.filter(
    (b) =>
      (b.proposerId === currentUser.id || b.acceptorId === currentUser.id) &&
      b.status === "settled"
  );

  const headToHead = useMemo(
    () => getHeadToHeadTotals(currentUser.id, users, bets, historyFilter),
    [currentUser.id, users, bets, historyFilter]
  );

  const outstanding = useMemo(
    () => getOutstandingBalances(currentUser.id, users, bets),
    [currentUser.id, users, bets]
  );

  function closeAuthModalForNow() {
    setShowAuthModal(false);
    setAuthError("");
  }

  async function handleSignup() {
    setAuthError("");

    if (!signupName || !signupEmail || !signupPassword) {
      setAuthError("Please fill out all create account fields.");
      return;
    }

    const { data, error } = await supabase.auth.signUp({
      email: signupEmail.trim(),
      password: signupPassword,
      options: {
        data: {
          name: signupName.trim(),
        },
      },
    });

    if (error) {
      setAuthError(error.message || "Could not create account.");
      return;
    }

    if (data.user) {
      setUsers((prev) => {
        const exists = prev.some((u) => u.id === data.user.id);
        if (exists) return prev;
        return [
          ...prev,
          {
            id: data.user.id,
            name: signupName.trim(),
            email: signupEmail.trim(),
          },
        ];
      });
    }

    setSignupName("");
    setSignupEmail("");
    setSignupPassword("");
    setShowAuthModal(false);
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
    setShowAuthModal(false);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    setMenuOpen(false);
    setShowAuthModal(true);
    setAuthMode("login");
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
    setBetAmount("");
    setWinAmount("");
  }

  function handleAmountChange(value) {
    const clean = value.replace(/[^\d.]/g, "");
    setBetAmount(clean);
    setWinAmount(clean);
  }

  function getCreateBetPayload() {
    if (betMode === "custom") {
      if (!customBetDetails.trim()) {
        return { error: "Add custom bet details." };
      }
      return { payload: buildCustomPayload(customBetDetails) };
    }

    if (!takingTeam.trim() || !againstTeam.trim()) {
      return { error: "Enter both taking and against team names." };
    }

    if (marketType === "total") {
      if (!totalNumber.trim()) {
        return { error: "Enter the total number." };
      }

      return {
        payload: buildClassicPayload({
          takingTeam,
          againstTeam,
          marketType,
          totalPick,
          totalNumber: totalNumber.trim(),
          sidePick,
          sideNumber,
        }),
      };
    }

    if (marketType === "side") {
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
        }),
      };
    }

    return { error: "Unable to build bet." };
  }

  async function handleCreateBet() {
    setCreateBetError("");

    if (!selectedOpponentId) {
      setCreateBetError("Select an opponent.");
      return;
    }

    if (!betAmount || !winAmount) {
      setCreateBetError("Enter bet amount and win amount.");
      return;
    }

    const result = getCreateBetPayload();

    if (result.error) {
      setCreateBetError(result.error);
      return;
    }

    const payload = result.payload;

    const newBet = {
      id: uid(),
      proposerId: currentUser.id,
      acceptorId: selectedOpponentId,
      text: serializeBetPayload(payload),
      betPayload: payload,
      amount: Number(betAmount),
      winAmount: Number(winAmount),
      status: "proposed",
      proposerGrade: null,
      acceptorGrade: null,
      proposerPaid: false,
      acceptorPaid: false,
      createdAt: getNow(),
      updatedAt: getNow(),
    };

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

    if (error) {
      setCreateBetError("Could not create bet.");
      return;
    }

    setBets((prev) => [newBet, ...prev]);
    setShowCreateBetModal(false);
    resetCreateBetModal();
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
      prev.map((b) =>
        b.id === betId ? { ...b, status: "declined", updatedAt } : b
      )
    );
  }

  async function gradeBet(betId, result) {
    const bet = bets.find((b) => b.id === betId);
    if (!bet) return;

    const isProposer = bet.proposerId === currentUser.id;
    const otherGrade = isProposer ? bet.acceptorGrade : bet.proposerGrade;
    const warning = gradeWarnings[betId];

    if (!otherGrade) {
      const updatedAt = getNow();
      const { error } = await supabase
        .from("bets")
        .update({
          proposer_grade: isProposer ? result : bet.proposerGrade,
          acceptor_grade: isProposer ? bet.acceptorGrade : result,
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

      const nextProposerGrade = isProposer ? result : bet.proposerGrade;
      const nextAcceptorGrade = isProposer ? bet.acceptorGrade : result;

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

  async function markPaid(betId) {
    const bet = bets.find((b) => b.id === betId);
    if (!bet) return;

    const isProposer = bet.proposerId === currentUser.id;
    const updatedAt = getNow();

    const nextProposerPaid = isProposer ? true : bet.proposerPaid;
    const nextAcceptorPaid = isProposer ? bet.acceptorPaid : true;
    const nextStatus =
      nextProposerPaid && nextAcceptorPaid ? "settled" : "graded";

    const { error } = await supabase
      .from("bets")
      .update({
        proposer_paid: nextProposerPaid,
        acceptor_paid: nextAcceptorPaid,
        status: nextStatus,
        updated_at: updatedAt,
      })
      .eq("id", betId);

    if (error) return;

    setBets((prev) =>
      prev.map((b) =>
        b.id === betId
          ? {
              ...b,
              proposerPaid: nextProposerPaid,
              acceptorPaid: nextAcceptorPaid,
              status: nextStatus,
              updatedAt,
            }
          : b
      )
    );
  }

  function renderGradeWarning(betId) {
    return gradeWarnings[betId] ? (
      <div className="errorText compactError">
        The other Player has selected a different outcome, are you sure?
      </div>
    ) : null;
  }

  function renderBetCard(bet, options = {}) {
    const proposerName = getUserName(users, bet.proposerId);
    const acceptorName = getUserName(users, bet.acceptorId);
    const isMine =
      bet.proposerId === currentUser.id || bet.acceptorId === currentUser.id;
    const iAmWinner =
      (bet.proposerId === currentUser.id &&
        bet.proposerGrade === "win" &&
        bet.acceptorGrade === "loss") ||
      (bet.acceptorId === currentUser.id &&
        bet.acceptorGrade === "win" &&
        bet.proposerGrade === "loss");

    const paymentText = iAmWinner ? "Got Paid" : "Paid";
    const headline = getBetHeadlineForViewer(bet, currentUser.id);
    const subline = getBetSublineForViewer(bet, currentUser.id, users);

    return (
      <div key={bet.id} className="betCard compact">
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
            ) : options.showPayment && isMine ? (
              <button className="greenBtn miniBtn" onClick={() => markPaid(bet.id)}>
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
          <div className="skeleton skeletonTitle" />
          <div className="skeleton skeletonSub" />

          <div className="sectionBlock">
            <div className="scrollList">
              {Array.from({ length: 4 }).map((_, i) => (
                <div className="betCard" key={i}>
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

  return (
    <>
      <style>{`
        :root {
          color-scheme: dark;
          font-family: Inter, system-ui, Arial, sans-serif;
        }

        * { box-sizing: border-box; }

        body {
          margin: 0;
          background:
            radial-gradient(circle at top, #121212 0%, #0a0a0a 45%, #050505 100%);
          color: white;
        }

        button, input, textarea {
          font: inherit;
        }

        .appShell {
          min-height: 100vh;
          padding: 16px;
        }

        .topbar {
          max-width: 1180px;
          margin: 0 auto 16px auto;
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }

        .titleBlock {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .pageTitle {
          margin: 0;
          font-size: 30px;
          font-weight: 800;
          letter-spacing: -0.02em;
        }

        .softText {
          color: #9ca3af;
        }

        .errorText {
          color: #f87171;
          font-size: 13px;
          margin-top: 12px;
        }

        .compactError {
          margin-top: 8px;
        }

        .menuWrap {
          position: relative;
        }

        .menuBtn {
          width: 48px;
          height: 48px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.05);
          color: white;
          cursor: pointer;
          font-size: 22px;
          backdrop-filter: blur(10px);
        }

        .menuPanel {
          position: absolute;
          right: 0;
          top: 56px;
          width: 220px;
          background: rgba(17,17,17,0.98);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 18px;
          overflow: hidden;
          z-index: 20;
          box-shadow: 0 16px 40px rgba(0,0,0,0.45);
        }

        .menuPanel button {
          width: 100%;
          text-align: left;
          padding: 13px 14px;
          background: transparent;
          border: none;
          color: white;
          cursor: pointer;
        }

        .menuPanel button:hover {
          background: rgba(255,255,255,0.06);
        }

        .pageGrid {
          max-width: 1180px;
          margin: 0 auto;
        }

        .prettyCard {
          background: linear-gradient(180deg, rgba(255,255,255,0.045), rgba(255,255,255,0.02));
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 24px;
          padding: 18px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.35);
          backdrop-filter: blur(8px);
        }

        .sectionHead {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 14px;
        }

        .sectionHead.tight {
          align-items: flex-start;
          flex-direction: column;
        }

        .sectionBlock {
          margin-top: 18px;
        }

        .sectionBlock h3,
        .prettyCard h2 {
          margin: 0 0 10px 0;
        }

        .greenBtn,
        .ghostBtn,
        .filterBtn,
        .tabBtn,
        .radioBtn {
          border-radius: 18px;
          padding: 10px 16px;
          cursor: pointer;
          transition: 0.15s ease;
        }

        .greenBtn {
          border: 1px solid rgba(34,197,94,0.22);
          background: linear-gradient(180deg, #26cf60 0%, #1db954 100%);
          color: white;
          font-weight: 700;
          box-shadow: 0 10px 24px rgba(34,197,94,0.20);
        }

        .greenBtn:hover {
          filter: brightness(1.05);
        }

        .ghostBtn {
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
          color: white;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.03);
        }

        .filterBtn,
        .tabBtn,
        .radioBtn {
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
          color: #d6d6d6;
        }

        .filterBtn.active,
        .tabBtn.active,
        .radioBtn.active {
          background: linear-gradient(180deg, #26cf60 0%, #1db954 100%);
          color: white;
          border-color: rgba(34,197,94,0.22);
        }

        .miniBtn {
          min-width: 118px;
          height: 52px;
          padding: 0 22px;
          border-radius: 22px;
          font-size: 16px;
        }

        .full {
          width: 100%;
        }

        .center {
          text-align: center;
        }

        .label {
          display: block;
          color: #9ca3af;
          font-size: 12px;
          margin-bottom: 4px;
        }

        .modalBackdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.72);
          display: flex;
          justify-content: center;
          align-items: center;
          padding: 18px;
          z-index: 100;
        }

        .modal {
          width: 100%;
          max-width: 560px;
          max-height: min(86vh, 760px);
          overflow-y: auto;
          background: linear-gradient(180deg, #111111 0%, #0b0b0b 100%);
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 24px;
          padding: 20px;
          position: relative;
          box-shadow: 0 24px 60px rgba(0,0,0,0.5);
        }

        .authModal {
          max-width: 460px;
        }

        .createBetModal {
          max-width: 500px;
        }

        .modalTitle {
          margin: 0 0 12px 0;
          font-size: 26px;
          font-weight: 800;
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

        .authToggleRow,
        .filterRow,
        .inlineBtns,
        .radioRow {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }

        .authToggleRow .tabBtn {
          flex: 1 1 0;
          text-align: center;
        }

        .fieldGroup {
          margin-top: 12px;
        }

        .fieldGroup label {
          display: block;
          margin-bottom: 6px;
          color: #d4d4d8;
          font-size: 13px;
        }

        input,
        textarea {
          width: 100%;
          padding: 12px 14px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.035);
          color: white;
          outline: none;
        }

        textarea {
          min-height: 90px;
          resize: vertical;
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

        .moneyInput span {
          color: #22c55e;
          font-weight: 800;
        }

        .moneyInput input {
          border: none;
          background: transparent;
          padding-left: 0;
        }

        .twoCol {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .autocompleteBox {
          margin-top: 8px;
          border: 1px solid rgba(255,255,255,0.10);
          border-radius: 16px;
          overflow: hidden;
          background: #111;
        }

        .autocompleteItem {
          width: 100%;
          border: none;
          background: transparent;
          color: white;
          text-align: left;
          padding: 10px 12px;
          cursor: pointer;
        }

        .autocompleteItem:hover {
          background: rgba(255,255,255,0.06);
        }

        .smallPad {
          padding: 10px 12px;
        }

        .scrollList {
          max-height: 520px;
          overflow-y: auto;
          display: grid;
          gap: 10px;
        }

        .betCard {
          background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.018));
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 28px;
          padding: 18px 22px;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.015);
        }

        .compact {
          padding: 18px 22px;
        }

        .betRowTop {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 16px;
          align-items: center;
        }

        .betLeft {
          min-width: 0;
          text-align: left;
        }

        .betRight {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          min-width: fit-content;
        }

        .betTitle {
          font-weight: 800;
          font-size: 18px;
          line-height: 1.22;
          letter-spacing: -0.01em;
        }

        .betSub {
          color: #98a1ae;
          font-size: 13px;
          margin-top: 6px;
        }

        .betRowBottom {
          display: flex;
          flex-wrap: wrap;
          gap: 10px 28px;
          color: #d4d4d8;
          font-size: 14px;
          margin-top: 14px;
        }

        .compactMeta {
          margin-top: 10px;
          font-size: 13px;
        }

        .statusPill {
          min-width: 110px;
          height: 52px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 1px solid rgba(255,255,255,0.10);
          background: rgba(255,255,255,0.03);
          border-radius: 24px;
          padding: 0 18px;
          font-size: 16px;
          white-space: nowrap;
          box-shadow: inset 0 0 0 1px rgba(255,255,255,0.02);
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
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.08);
        }

        th {
          color: #9ca3af;
          font-size: 13px;
        }

        .greenText {
          color: #22c55e;
          font-weight: 700;
        }

        .redText {
          color: #ef4444;
          font-weight: 700;
        }

        .emptyState,
        .emptyCell {
          color: #8f8f8f;
          padding: 18px 6px;
          text-align: center;
        }

        .ctaSpacing {
          margin-top: 18px;
        }

        .skeleton {
          position: relative;
          overflow: hidden;
          border-radius: 14px;
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
            rgba(255,255,255,0.18) 50%,
            rgba(255,255,255,0.08) 55%,
            rgba(255,255,255,0) 100%
          );
          animation: skeletonSweep 1.4s ease-in-out infinite;
        }

        .skeletonTitle {
          width: 180px;
          height: 28px;
          margin-bottom: 8px;
        }

        .skeletonSub {
          width: 130px;
          height: 14px;
        }

        .skeletonLineLg {
          width: 72%;
          height: 18px;
          margin-bottom: 8px;
        }

        .skeletonLineSm {
          width: 44%;
          height: 14px;
          margin-bottom: 10px;
        }

        .skeletonRow {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        .skeletonBox {
          width: 100%;
          height: 40px;
        }

        @keyframes skeletonSweep {
          100% {
            transform: translateX(100%);
          }
        }

        @media (max-width: 700px) {
          .appShell {
            padding: 12px;
          }

          .twoCol {
            grid-template-columns: 1fr;
          }

          .sectionHead {
            flex-direction: column;
            align-items: stretch;
          }

          .pageTitle {
            font-size: 24px;
          }

          .prettyCard {
            padding: 14px;
            border-radius: 20px;
          }

          .modal {
            padding: 18px;
            border-radius: 20px;
          }

          .betCard,
          .compact {
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
            min-width: 102px;
            height: 48px;
            font-size: 15px;
          }
        }
      `}</style>

      <div className="appShell">
        <header className="topbar">
          <div className="titleBlock">
            <h1 className="pageTitle">Bet Tracker</h1>
            <div className="softText">
              {authUser ? `Logged in as ${currentUser.name}` : "Preview mode"}
            </div>
          </div>

          <div className="menuWrap" onClick={(e) => e.stopPropagation()}>
            <button className="menuBtn" onClick={() => setMenuOpen((p) => !p)}>
              ☰
            </button>

            {menuOpen && (
              <div className="menuPanel">
                <button
                  onClick={() => {
                    setPage("home");
                    setMenuOpen(false);
                  }}
                >
                  Home
                </button>
                <button
                  onClick={() => {
                    setPage("mybets");
                    setMenuOpen(false);
                  }}
                >
                  My Bets
                </button>
                <button
                  onClick={() => {
                    setPage("history");
                    setMenuOpen(false);
                  }}
                >
                  Bet History & Stats
                </button>
                <button onClick={handleLogout}>Log Out</button>
              </div>
            )}
          </div>
        </header>

        {authLoading || isLoadingBets ? (
          renderSkeletonScreen()
        ) : (
          <>
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

                  <h2 className="modalTitle">Create a Bet</h2>

                  <div className="fieldGroup">
                    <label>Proposed By</label>
                    <input value={currentUser.name} disabled />
                  </div>

                  <div className="fieldGroup">
                    <label>Select Opponent</label>
                    <input
                      value={opponentSearch}
                      onChange={(e) => {
                        setOpponentSearch(e.target.value);
                        setSelectedOpponentId("");
                      }}
                      placeholder="Start typing a name"
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
                                setOpponentSearch(user.name);
                              }}
                            >
                              {user.name}
                            </button>
                          ))
                        ) : (
                          <div className="smallPad softText">No matching users</div>
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
                            onClick={() => setMarketType("total")}
                          >
                            Total
                          </button>
                          <button
                            type="button"
                            className={marketType === "side" ? "radioBtn active" : "radioBtn"}
                            onClick={() => setMarketType("side")}
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
                                onClick={() => setSidePick("ml")}
                              >
                                ML
                              </button>
                              <button
                                type="button"
                                className={sidePick === "plus" ? "radioBtn active" : "radioBtn"}
                                onClick={() => setSidePick("plus")}
                              >
                                +
                              </button>
                              <button
                                type="button"
                                className={sidePick === "minus" ? "radioBtn active" : "radioBtn"}
                                onClick={() => setSidePick("minus")}
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
                            setWinAmount(e.target.value.replace(/[^\d.]/g, ""))
                          }
                          placeholder="0"
                        />
                      </div>
                    </div>
                  </div>

                  {createBetError && <div className="errorText">{createBetError}</div>}

                  <button className="greenBtn full ctaSpacing" onClick={handleCreateBet}>
                    Propose Bet
                  </button>
                </div>
              </div>
            )}

            {page === "home" && (
              <main className="pageGrid">
                <section className="prettyCard">
                  <div className="sectionHead">
                    <h2>Home</h2>
                    <button className="greenBtn" onClick={() => setShowCreateBetModal(true)}>
                      Create a Bet
                    </button>
                  </div>

                  <div className="sectionBlock">
                    <h3>Accepted Open Bets</h3>
                    <div className="scrollList">
                      {openBetsFeed.slice(0, 14).map((bet) => renderBetCard(bet))}
                      {!openBetsFeed.length && (
                        <div className="emptyState">No accepted open bets yet.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <div className="sectionHead tight">
                      <h3>Total Win/Loss Results</h3>
                      <div className="filterRow">
                        {filters.map((filter) => (
                          <button
                            key={filter}
                            className={
                              leaderboardFilter === filter ? "filterBtn active" : "filterBtn"
                            }
                            onClick={() => setLeaderboardFilter(filter)}
                          >
                            {filter}
                          </button>
                        ))}
                      </div>
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
                          {leaderboard.map((row) => (
                            <tr key={row.userId}>
                              <td>{row.name}</td>
                              <td className={row.net >= 0 ? "greenText" : "redText"}>
                                {currency(row.net)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </section>
              </main>
            )}

            {page === "mybets" && (
              <main className="pageGrid">
                <section className="prettyCard">
                  <h2>My Bets</h2>

                  <div className="sectionBlock">
                    <h3>All Bets You Proposed</h3>
                    <div className="scrollList">
                      {myProposedBets.slice(0, 14).map((bet) =>
                        renderBetCard(bet, { showDelete: true })
                      )}
                      {!myProposedBets.length && (
                        <div className="emptyState">No pending proposed bets.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Bets Others Proposed To You</h3>
                    <div className="scrollList">
                      {proposedToMe.slice(0, 14).map((bet) =>
                        renderBetCard(bet, { showAcceptDecline: true })
                      )}
                      {!proposedToMe.length && (
                        <div className="emptyState">No bets proposed to you.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>All Bets Pending</h3>
                    <div className="scrollList">
                      {pendingBets.slice(0, 14).map((bet) =>
                        renderBetCard(bet, { showGrade: true })
                      )}
                      {!pendingBets.length && (
                        <div className="emptyState">No accepted bets waiting on grading.</div>
                      )}
                    </div>
                  </div>
                </section>
              </main>
            )}

            {page === "history" && (
              <main className="pageGrid">
                <section className="prettyCard">
                  <h2>Bet History & Stats</h2>

                  <div className="sectionBlock">
                    <h3>Bet Status</h3>
                    <div className="scrollList">
                      {unpaidGradedBets.slice(0, 14).map((bet) =>
                        renderBetCard(bet, { showPayment: true })
                      )}
                      {!unpaidGradedBets.length && (
                        <div className="emptyState">No graded unpaid bets right now.</div>
                      )}
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Who Owes Who</h3>
                    <div className="tableWrap">
                      <table>
                        <thead>
                          <tr>
                            <th>User</th>
                            <th>Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {outstanding.length ? (
                            outstanding.map((row) => (
                              <tr key={row.userId}>
                                <td>{row.name}</td>
                                <td className={row.net >= 0 ? "greenText" : "redText"}>
                                  {currency(row.net)}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan="2" className="emptyCell">
                                No outstanding balances
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <div className="sectionHead tight">
                      <h3>Bet History</h3>
                      <div className="filterRow">
                        {filters.map((filter) => (
                          <button
                            key={filter}
                            className={
                              historyFilter === filter ? "filterBtn active" : "filterBtn"
                            }
                            onClick={() => setHistoryFilter(filter)}
                          >
                            {filter}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="tableWrap">
                      <table>
                        <thead>
                          <tr>
                            <th>User</th>
                            <th>You Are</th>
                          </tr>
                        </thead>
                        <tbody>
                          {headToHead.length ? (
                            headToHead.map((row) => (
                              <tr key={row.userId}>
                                <td>{row.name}</td>
                                <td className={row.net >= 0 ? "greenText" : "redText"}>
                                  {currency(row.net)}
                                </td>
                              </tr>
                            ))
                          ) : (
                            <tr>
                              <td colSpan="2" className="emptyCell">
                                No graded bets in this filter
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="sectionBlock">
                    <h3>Past Bets</h3>
                    <div className="scrollList">
                      {paidHistory.slice(0, 14).map((bet) => renderBetCard(bet))}
                      {!paidHistory.length && (
                        <div className="emptyState">No fully settled bets yet.</div>
                      )}
                    </div>
                  </div>
                </section>
              </main>
            )}
          </>
        )}

        {showAuthModal && (
          <div className="modalBackdrop">
            <div className="modal authModal">
              <button className="closeX" onClick={closeAuthModalForNow}>
                ×
              </button>

              <h1 className="modalTitle">
                {authMode === "signup" ? "Create account" : "Sign In"}
              </h1>

              <p className="softText center">
                Create an account, sign in, or close this for a quick preview.
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
                    <label>Name</label>
                    <input
                      value={signupName}
                      onChange={(e) => setSignupName(e.target.value)}
                      placeholder="Enter name"
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
                  {authError && <div className="errorText">{authError}</div>}
                  <button className="greenBtn full ctaSpacing" onClick={handleSignup}>
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
                  {authError && <div className="errorText">{authError}</div>}
                  <button className="greenBtn full ctaSpacing" onClick={handleLogin}>
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