

const BASE_URL = window.location.hostname === "localhost"
  ? "http://localhost:3000"
  : "https://voiceai1-0.onrender.com";
const TOPIC_CAPTURE_MS = 5000;
const state = {
  interviewId: "",
  topic: "",
  questionNumber: 0,
  currentQuestion: "",
  questionOpen: false,
  answerStartedAt: 0,
  history: [],
  busy: false,
  recording: false,
  captureMode: null,
  mediaStream: null,
  mediaRecorder: null,
  audioChunks: []
};

const topicNotice = document.getElementById("topicNotice");
const startButton = document.getElementById("startButton");
const workspacePanel = document.getElementById("workspacePanel");
const finalPanel = document.getElementById("finalPanel");
const questionText = document.getElementById("questionText");
const questionMeta = document.getElementById("questionMeta");
const answerButton = document.getElementById("answerButton");
const nextButton = document.getElementById("nextButton");
const finishButton = document.getElementById("finishButton");
const historyList = document.getElementById("historyList");
const techPill = document.getElementById("techPill");
const progressPill = document.getElementById("progressPill");
const statusPill = document.getElementById("statusPill");
const micPill = document.getElementById("micPill");
const stepNotice = document.getElementById("stepNotice");

function setBusy(isBusy) {
  state.busy = isBusy;
  document.body.classList.toggle("loading", isBusy);
  startButton.disabled = isBusy;
  answerButton.disabled = isBusy;
  nextButton.disabled = isBusy;
  finishButton.disabled = isBusy;
}

function setRecordingState(isRecording) {
  state.recording = isRecording;
  const recordingLabel = !isRecording
    ? "Off"
    : state.captureMode === "topic"
      ? "Recording tech"
      : "Recording answer";

  micPill.innerHTML = `Mic: <strong>${recordingLabel}</strong>`;

  const canStartAnswer = !isRecording && state.questionOpen && !!state.currentQuestion;
  const canSubmitAnswer = isRecording && state.captureMode === "answer";
  answerButton.classList.toggle("hidden", !canStartAnswer);
  answerButton.disabled = !canStartAnswer || state.busy;
  nextButton.classList.toggle("hidden", !canSubmitAnswer);
  nextButton.disabled = !canSubmitAnswer || state.busy;
  finishButton.classList.toggle("hidden", state.history.length === 0);
  finishButton.disabled = state.busy;
}

function setStatus(text, color = "") {
  statusPill.innerHTML = `Status: <strong>${text}</strong>`;
  statusPill.style.color = color || "var(--muted)";
}

function renderHistory() {
  historyList.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "No answers yet. Your interview history will appear here.";
    historyList.appendChild(empty);
    return;
  }

  state.history.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "history-card";

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = `Question ${index + 1}`;

    const question = document.createElement("p");
    question.className = "q";
    question.textContent = `Q: ${item.question}`;

    const answer = document.createElement("p");
    answer.className = "a";
    answer.textContent = `A: ${item.answer}`;

    card.append(tag, question, answer);
    historyList.appendChild(card);
  });
}

function updateQuestionView(question, questionNumber) {
  state.currentQuestion = question;
  state.questionNumber = questionNumber;
  state.questionOpen = false;
  questionText.textContent = question;
  questionMeta.textContent = `Question ${questionNumber}. Click Start Answering when you are ready, then speak your answer.`;
  progressPill.innerHTML = `Questions answered: <strong>${state.history.length}</strong>`;
  techPill.innerHTML = `Topic: <strong>${state.topic}</strong>`;
  setStatus("In progress");
}

async function ensureMicrophone() {
  if (state.mediaStream && state.mediaStream.active) {
    return state.mediaStream;
  }

  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return state.mediaStream;
}

function playAudio(base64, fallbackText) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    // Safety timeout: never block interview flow on media playback issues.
    const timer = window.setTimeout(done, 20000);

    if (base64) {
      const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
      audio.onended = () => {
        window.clearTimeout(timer);
        done();
      };
      audio.onerror = () => {
        if (fallbackText && "speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(fallbackText);
          utterance.onend = () => {
            window.clearTimeout(timer);
            done();
          };
          utterance.onerror = () => {
            window.clearTimeout(timer);
            done();
          };
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
        } else {
          window.clearTimeout(timer);
          done();
        }
      };

      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          if (fallbackText && "speechSynthesis" in window) {
            const utterance = new SpeechSynthesisUtterance(fallbackText);
            utterance.onend = () => {
              window.clearTimeout(timer);
              done();
            };
            utterance.onerror = () => {
              window.clearTimeout(timer);
              done();
            };
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);
          } else {
            window.clearTimeout(timer);
            done();
          }
        });
      }

      return;
    }

    if (fallbackText && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(fallbackText);
      utterance.onend = () => {
        window.clearTimeout(timer);
        done();
      };
      utterance.onerror = () => {
        window.clearTimeout(timer);
        done();
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return;
    }

    window.clearTimeout(timer);
    done();
  });
}

async function startRecording() {
  await ensureMicrophone();
  state.audioChunks = [];
  state.answerStartedAt = Date.now();
  state.captureMode = "answer";
  state.mediaRecorder = new MediaRecorder(state.mediaStream);

  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      state.audioChunks.push(event.data);
    }
  };

  state.mediaRecorder.start();
  setRecordingState(true);
  setStatus("Listening", "var(--good)");
  stepNotice.textContent = "Speak your answer, then click Next to send it.";
}

async function startAnswering() {
  if (!state.currentQuestion || state.busy || state.recording) {
    return;
  }

  await startRecording();
}

async function captureTopicAudio() {
  await ensureMicrophone();

  return new Promise((resolve, reject) => {
    const chunks = [];
    const recorder = new MediaRecorder(state.mediaStream);
    state.captureMode = "topic";

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    recorder.onerror = () => {
      reject(new Error("Could not record topic audio"));
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      resolve(blob);
    };

    recorder.start();
    setRecordingState(true);
    setStatus("Listening for topic", "var(--good)");
    stepNotice.textContent = "Speak your topic now...";

    window.setTimeout(() => {
      if (recorder.state === "recording") {
        recorder.stop();
      }
    }, TOPIC_CAPTURE_MS);
  });
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
      resolve(null);
      return;
    }

    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.audioChunks, {
        type: state.mediaRecorder.mimeType || "audio/webm"
      });
      resolve(blob);
    };

    state.mediaRecorder.stop();
  });
}

function stopRecordingSilently() {
  return new Promise((resolve) => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
      resolve();
      return;
    }

    state.mediaRecorder.onstop = () => {
      state.audioChunks = [];
      resolve();
    };

    state.mediaRecorder.stop();
  });
}

async function askQuestion(questionTextValue, questionAudio) {
  setRecordingState(false);
  state.captureMode = null;
  state.questionOpen = false;
  setStatus("AI speaking", "var(--accent)");
  stepNotice.textContent = "Listen to the question, then answer when the microphone opens.";
  await playAudio(questionAudio, questionTextValue);
  state.questionOpen = true;
  setRecordingState(false);
  setStatus("Ready", "var(--accent)");
  stepNotice.textContent = "Click Start Answering when you are ready to respond.";
}

async function startInterview() {
  setBusy(true);
  finalPanel.classList.add("hidden");
  workspacePanel.classList.remove("hidden");
  state.topic = "";
  state.interviewId = "";
  state.questionNumber = 0;
  state.currentQuestion = "";
  state.questionOpen = false;
  state.answerStartedAt = 0;
  state.history = [];
  state.captureMode = null;
  setRecordingState(false);
  topicNotice.textContent = "Listening...";
  stepNotice.textContent = "Preparing your voice interview...";
  renderHistory();

  try {
    await ensureMicrophone();

    const topicPrompt = "Which topic do you want me to ask questions about? Say it clearly after this message.";
    await playAudio(null, topicPrompt);

    const topicAudio = await captureTopicAudio();
    setRecordingState(false);
    state.captureMode = null;
    setStatus("Detecting topic", "var(--accent)");
    stepNotice.textContent = "Identifying topic from your voice...";

    const topicFormData = new FormData();
    topicFormData.append("audio", topicAudio, "topic.webm");

    const topicResponse = await fetch(`${BASE_URL}/api/interview/topic`, {
      method: "POST",
      body: topicFormData
    });

    const topicData = await topicResponse.json();

    if (!topicResponse.ok) {
      throw new Error(topicData.error || "Unable to detect topic");
    }

    state.topic = topicData.topic;
    topicNotice.textContent = `Detected topic: ${state.topic}`;

    const response = await fetch(`${BASE_URL}/api/interview/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: state.topic })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to start interview");
    }

    state.interviewId = data.interviewId;
    updateQuestionView(data.question, data.questionNumber);
    await askQuestion(data.question, data.questionAudio);
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
    setRecordingState(false);
    state.captureMode = null;
    technologyNotice.textContent = "Could not detect topic. Click start and speak again.";
  } finally {
    setBusy(false);
  }
}

async function submitNextAnswer() {
  if (!state.currentQuestion) {
    return;
  }

  if (!state.recording || state.captureMode !== "answer") {
    alert("Click Start Answering and say something before moving next.");
    return;
  }

  setBusy(true);

  try {
    const answerBlob = await stopRecording();
    const recordingDuration = Date.now() - state.answerStartedAt;

    if (!answerBlob || answerBlob.size === 0 || recordingDuration < 1200) {
      alert("Please say something before moving next.");
      setRecordingState(false);
      state.answerStartedAt = 0;
      setStatus("Ready", "var(--accent)");
      stepNotice.textContent = "Click Start Answering when you are ready to respond.";
      setBusy(false);
      return;
    }

    setRecordingState(false);
    setStatus("Transcribing", "var(--accent)");
    stepNotice.textContent = "Transcribing your answer and preparing the next question...";

    const formData = new FormData();
    formData.append("interviewId", state.interviewId);
    formData.append("currentQuestion", state.currentQuestion);
    formData.append("questionNumber", String(state.questionNumber));
    formData.append("audio", answerBlob, "answer.webm");

    const response = await fetch(`${BASE_URL}/api/interview/next`, {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to move to the next question");
    }

    if (!data.nextQuestion) {
      throw new Error("Could not fetch next question. Please try Next again.");
    }

    state.history = data.history;

    renderHistory();
    setRecordingState(false);
  state.answerStartedAt = 0;

    updateQuestionView(data.nextQuestion, data.questionNumber);
    stepNotice.textContent = "Answer saved. Moving to the next question.";
    await askQuestion(data.nextQuestion, data.nextQuestionAudio);
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
    setRecordingState(false);
  } finally {
    setBusy(false);
  }
}

async function finishInterview() {
  if (!state.history.length) {
    return;
  }

  setBusy(true);
  stepNotice.textContent = "Generating final assessment...";

  try {
    const response = await fetch(`${BASE_URL}/api/interview/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        interviewId: state.interviewId
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to finish interview");
    }

    const assessment = data.assessment;
    finalPanel.classList.remove("hidden");
    document.getElementById("finalVerdict").textContent = assessment.verdict;
    // Cap the score at 10 for display
    const cappedScore = Math.min(Number(assessment.overallScore), 10);
    document.getElementById("finalScore").textContent = `${cappedScore}/10`;
    document.getElementById("finalRecommendation").textContent = assessment.recommendation;
    document.getElementById("finalSummary").textContent = assessment.summary;

    const strengths = document.getElementById("finalStrengths");
    const gaps = document.getElementById("finalGaps");
    strengths.innerHTML = "";
    gaps.innerHTML = "";

    if ((assessment.strengths || []).length) {
      assessment.strengths.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        strengths.appendChild(li);
      });
    } else {
      const li = document.createElement("li");
      li.textContent = "No strengths returned.";
      strengths.appendChild(li);
    }

    if ((assessment.gaps || []).length) {
      assessment.gaps.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        gaps.appendChild(li);
      });
    } else {
      const li = document.createElement("li");
      li.textContent = "No gaps returned.";
      gaps.appendChild(li);
    }

    setStatus(assessment.canProceed ? "Ready" : "Needs practice", assessment.canProceed ? "var(--good)" : "var(--bad)");
    stepNotice.textContent = "Final assessment complete.";
    await playAudio(data.assessmentAudio, `${assessment.verdict}. ${assessment.summary} Recommendation: ${assessment.recommendation}.`);
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
  } finally {
    setBusy(false);
  }
}

async function endInterview() {
  if (state.busy) {
    return;
  }

  setBusy(true);

  try {
    await stopRecordingSilently();
    setRecordingState(false);
    state.captureMode = null;
    await finishInterview();
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
  } finally {
    setBusy(false);
  }
}




renderHistory();