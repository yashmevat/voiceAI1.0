const express = require("express");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config();

fs.mkdirSync("uploads", { recursive: true });

const app = express();
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const interviewSessions = new Map();

app.use(express.json({ limit: "1mb" }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJsonResponse(content, fallback) {
  try {
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function createJsonChatCompletion(messages, fallback) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content || "{}";
  return parseJsonResponse(content, fallback);
}

async function speakText(text) {
  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: text
  });

  return Buffer.from(await speech.arrayBuffer()).toString("base64");
}

async function safeSpeakText(text) {
  try {
    return await speakText(text);
  } catch (error) {
    console.error("TTS failed:", error?.message || error);
    return null;
  }
}

async function transcribeAudioFile(filePath, originalName, mimeType) {
  const audioFile = await OpenAI.toFile(
    fs.createReadStream(filePath),
    originalName,
    { type: mimeType }
  );

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: "whisper-1"
  });

  return transcription.text || "";
}

function fallbackQuestionText(topic) {
  return `Please walk me through one practical experience or concept you have worked with in ${topic}.`;
}

// ─── Question aspect rotation ─────────────────────────────────────────────────

const QUESTION_ASPECTS = [
  "conceptual understanding",
  "real-world scenario or problem-solving",
  "best practices and trade-offs",
  "debugging or troubleshooting experience",
  "system design or architecture thinking",
  "team collaboration or communication of technical ideas",
  "performance, scaling, or optimization",
  "tools, libraries, or ecosystem knowledge"
];

function pickAspect(questionNumber) {
  return QUESTION_ASPECTS[(questionNumber - 1) % QUESTION_ASPECTS.length];
}

// ─── Core AI functions ────────────────────────────────────────────────────────

async function generateQuestion(topic, history, questionNumber) {
  const aspect = pickAspect(questionNumber);

  const historySummary = history.length
    ? history
        .map(
          (h, i) =>
            `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`
        )
        .join("\n\n")
    : "No previous questions yet.";

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are a professional voice interviewer specializing in the field/domain: "${topic}".

Your job is to ask exactly ONE interview question per turn. The question must:
- Focus on this aspect: "${aspect}"
- Be informed by the candidate's previous answers — do NOT repeat what was already asked or answered
- Progress naturally from easy → intermediate → advanced as the interview continues
- Be speakable out loud: short, conversational, no code blocks, no special symbols, no syntax-heavy content
- If testing technical depth, ask the candidate to explain their approach or reasoning, not to write code

Return JSON with keys:
- question: the single interview question (string)
- aspect: the aspect being tested (string)
- difficulty: difficulty from 1-10 (number)
- reasoning: one sentence explaining why you chose this question given the history (string)`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          questionNumber,
          aspect,
          previousQuestionsAndAnswers: historySummary
        })
      }
    ],
    {
      question: fallbackQuestionText(topic),
      aspect,
      difficulty: 5,
      reasoning: "Fallback question due to generation error."
    }
  );
}

async function makeVoiceFriendlyQuestion(topic, question) {
  const rewritten = await createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are preparing interview questions for voice delivery in the field/domain: "${topic}".

Rewrite the question so it sounds natural when spoken aloud. Rules:
- Keep the same intent and difficulty
- Use short, clear sentences with no special characters, no code syntax, no angle brackets, no markdown
- If it asks to write code, convert it to: "Can you explain how you would approach..." or "Walk me through how..."
- End with a natural verbal cue like "Go ahead." or "Take your time."

Return JSON with key: question`
      },
      {
        role: "user",
        content: JSON.stringify({ question })
      }
    ],
    {
      question: `${question} Please explain verbally, no code needed.`
    }
  );

  const speakable = String(rewritten.question || question || "").trim();
  return speakable || fallbackQuestionText(topic);
}

async function evaluateAnswer(topic, question, answer, history) {
  const historySummary = history.length
    ? history
        .map((h, i) => `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}`)
        .join("\n\n")
    : "This is the first answer.";

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are an expert interviewer evaluating a candidate's verbal answer in the domain: "${topic}".

Evaluate the answer on these dimensions (each scored 1-10):
- technicalAccuracy: Is the answer factually correct and relevant?
- depth: Does the candidate go beyond surface-level explanation?
- clarity: Is the answer clear, structured, and easy to follow?
- confidence: Does the answer sound confident and decisive?
- relevance: Does it directly address the question asked?

Also provide:
- overallScore: weighted average (number 1-10)
- feedback: 1-2 sentence constructive feedback the candidate can learn from
- keyStrength: one thing done well in this answer
- keyGap: one thing missing or weak in this answer

Consider the full history of answers when assessing improvement or patterns.

Return JSON with keys: technicalAccuracy, depth, clarity, confidence, relevance, overallScore, feedback, keyStrength, keyGap`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          question,
          answer,
          previousHistory: historySummary
        })
      }
    ],
    {
      technicalAccuracy: 5,
      depth: 5,
      clarity: 5,
      confidence: 5,
      relevance: 5,
      overallScore: 5,
      feedback: "Unable to evaluate this answer.",
      keyStrength: "Attempted an answer.",
      keyGap: "More detail needed."
    }
  );
}

async function finalAssessment(topic, history) {
  const historySummary = history
    .map(
      (h, i) =>
        `Q${i + 1}: ${h.question}\nA${i + 1}: ${h.answer}\nEvaluation: ${JSON.stringify(h.evaluation || {})}`
    )
    .join("\n\n");

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are a senior hiring manager giving a final assessment after a full voice interview on the domain: "${topic}".

Analyze ALL questions and answers holistically. Your assessment must cover:

1. canProceed (boolean) — Is the candidate ready to work in this domain?
2. verdict (string) — One of: "Strong Hire", "Hire", "Consider", "No Hire"
3. overallScore (number 1-10) — Weighted average across all answers
4. confidenceScore (number 1-10) — How confident and clear was the candidate overall?
5. technicalScore (number 1-10) — How strong is their domain knowledge?
6. communicationScore (number 1-10) — How well did they articulate their thoughts?
7. summary (string) — 3-4 sentence narrative summary of the candidate's performance
8. strengths (array of strings) — 3-5 specific strengths observed across the interview
9. gaps (array of strings) — 3-5 specific weaknesses or knowledge gaps identified
10. recommendation (string) — 2-3 sentence hiring recommendation with next steps
11. areasToImprove (array of strings) — 2-4 actionable topics the candidate should study or practice
12. interviewProgression (string) — Did the candidate improve, decline, or stay consistent across questions?

Be honest, specific, and grounded in the actual answers given. Do not be generic.

Return JSON with all keys above.`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          totalQuestions: history.length,
          fullInterviewTranscript: historySummary
        })
      }
    ],
    {
      canProceed: false,
      verdict: "No Hire",
      overallScore: 5,
      confidenceScore: 5,
      technicalScore: 5,
      communicationScore: 5,
      summary: "Unable to generate a final assessment.",
      strengths: [],
      gaps: [],
      recommendation: "Try again with clearer, more detailed answers.",
      areasToImprove: [],
      interviewProgression: "Consistent"
    }
  );
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post("/api/interview/topic", upload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const originalName = req.file?.originalname || "topic.webm";
  const mimeType = req.file?.mimetype || "audio/webm";

  if (!audioPath) {
    return res.status(400).json({ error: "Topic audio is required" });
  }

  try {
    const topicRaw = await transcribeAudioFile(audioPath, originalName, mimeType);
    const topic = topicRaw.trim().replace(/[.,!?]+$/g, "");

    if (!topic) {
      return res.status(400).json({ error: "Could not detect topic name" });
    }

    res.json({ topic });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to process topic audio" });
  } finally {
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

app.post("/api/interview/start", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").trim();
    const language = (req.body?.language || "English").trim();
    const scenario = (req.body?.scenario || "").trim();
    const behavior = (req.body?.behavior || "professional").trim();

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    const firstQuestion = await generateQuestion(topic, [], 1);
    const voiceQuestion = await makeVoiceFriendlyQuestion(
      topic,
      firstQuestion.question || fallbackQuestionText(topic)
    );
    const questionAudio = await safeSpeakText(voiceQuestion);
    const interviewId = crypto.randomUUID();

    interviewSessions.set(interviewId, {
      topic,
      language,
      scenario,
      behavior,
      history: [],
      createdAt: Date.now()
    });

    res.json({
      interviewId,
      questionNumber: 1,
      question: voiceQuestion,
      questionAudio,
      topic: firstQuestion.topic || topic,
      aspect: firstQuestion.aspect,
      difficulty: firstQuestion.difficulty,
      language,
      scenario,
      behavior
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to start interview" });
  }
});

app.post("/api/interview/next", upload.single("audio"), async (req, res) => {
  try {
    const interviewId = (req.body?.interviewId || "").trim();
    const currentQuestion = (req.body?.currentQuestion || "").trim();
    const audioPath = req.file?.path;
    const originalName = req.file?.originalname || "answer.webm";
    const mimeType = req.file?.mimetype || "audio/webm";
    const session = interviewSessions.get(interviewId);

    if (!session) return res.status(400).json({ error: "Interview session not found" });
    if (!currentQuestion) return res.status(400).json({ error: "Question is required" });
    if (!audioPath) return res.status(400).json({ error: "Audio answer is required" });

    const currentAnswer = await transcribeAudioFile(audioPath, originalName, mimeType);

    if (!currentAnswer.trim()) {
      return res.status(400).json({ error: "Could not transcribe the audio answer" });
    }

    // Evaluate the current answer before generating the next question
    const evaluation = await evaluateAnswer(
      session.topic,
      currentQuestion,
      currentAnswer,
      session.history
    );

    session.history.push({
      question: currentQuestion,
      answer: currentAnswer,
      evaluation
    });

    const nextQuestionNumber = session.history.length + 1;

    let nextQuestion;
    try {
      const generated = await generateQuestion(
        session.topic,
        session.history,
        nextQuestionNumber
      );
      const voiceNextQuestion = await makeVoiceFriendlyQuestion(
        session.topic,
        generated.question || fallbackQuestionText(session.topic)
      );
      nextQuestion = {
        text: voiceNextQuestion,
        aspect: generated.aspect,
        difficulty: generated.difficulty,
        reasoning: generated.reasoning
      };
    } catch (error) {
      console.error("Question generation failed:", error?.message || error);
      nextQuestion = {
        text: `Please share one practical experience related to ${session.topic}. Take your time.`,
        aspect: "real-world experience",
        difficulty: 5,
        reasoning: "Fallback due to generation error."
      };
    }

    const nextQuestionAudio = await safeSpeakText(nextQuestion.text);

    res.json({
      interviewId,
      questionNumber: nextQuestionNumber,
      history: session.history,
      currentAnswer,
      evaluation,
      nextQuestion: nextQuestion.text,
      nextQuestionAudio,
      aspect: nextQuestion.aspect,
      difficulty: nextQuestion.difficulty,
      reasoning: nextQuestion.reasoning
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to continue interview" });
  } finally {
    const audioPath = req.file?.path;
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

app.post("/api/interview/finish", async (req, res) => {
  try {
    const interviewId = (req.body?.interviewId || "").trim();
    const session = interviewSessions.get(interviewId);

    if (!session) return res.status(400).json({ error: "Interview session not found" });
    if (!session.history.length) {
      return res.status(400).json({ error: "Answer at least one question before finishing" });
    }

    const assessment = await finalAssessment(session.topic, session.history);

    const ttsText = [
      `Final verdict: ${assessment.verdict}.`,
      assessment.summary,
      `Overall score: ${assessment.overallScore} out of 10.`,
      `Recommendation: ${assessment.recommendation}`
    ].join(" ");

    const assessmentAudio = await safeSpeakText(ttsText);

    interviewSessions.delete(interviewId);

    res.json({
      topic: session.topic,
      history: session.history,
      assessment,
      assessmentAudio
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to finish interview" });
  }
});

// ─── Legacy single-turn voice interview ───────────────────────────────────────

app.post("/interview", upload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const originalName = req.file?.originalname || "audio.webm";
  const mimeType = req.file?.mimetype || "audio/webm";

  if (!audioPath) return res.status(400).send("No audio file uploaded");

  try {
    const audioFile = await OpenAI.toFile(
      fs.createReadStream(audioPath),
      originalName,
      { type: mimeType }
    );

    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1"
    });

    const userText = transcription.text;

    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are a professional voice interviewer conducting a real-time interview.

Your task:
1. Evaluate the candidate's answer on grammar, confidence, and technical accuracy
2. Ask one follow-up or next interview question that naturally builds on what they just said

Rules for your question:
- Conversational and speakable, no code syntax, no markdown
- Short and clear — one sentence preferred
- Vary the aspect: sometimes conceptual, sometimes scenario-based, sometimes best-practices

Return JSON:
{
  "reply": "your next question (string)",
  "score": overall score 1-10 (number),
  "grammar": grammar score 1-10 (number),
  "confidence": confidence score 1-10 (number),
  "technical": technical accuracy score 1-10 (number),
  "feedback": "1-2 sentence feedback on their answer (string)"
}`
        },
        {
          role: "user",
          content: userText
        }
      ]
    });

    const content = aiResponse.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        reply: content,
        score: 5,
        grammar: 5,
        confidence: 5,
        technical: 5,
        feedback: "Could not parse structured response."
      };
    }

    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: parsed.reply
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());

    res.json({
      userText,
      aiText: parsed.reply,
      scores: {
        score: parsed.score,
        grammar: parsed.grammar,
        confidence: parsed.confidence,
        technical: parsed.technical
      },
      feedback: parsed.feedback,
      audio: audioBuffer.toString("base64")
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing interview");
  } finally {
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});