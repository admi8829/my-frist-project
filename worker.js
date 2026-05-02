// --- Supabase Helper Function ---
async function callSupabase(env, table, method, query = "", body = null) {
  const url = `${env.SUPABASE_URL}/rest/v1/${table}${query}`;
  const options = {
    method: method,
    headers: {
      "apikey": env.SUPABASE_KEY,
      "Authorization": `Bearer ${env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation,resolution=merge-duplicates"
    }
  };
  if (body) options.body = JSON.stringify(body);
  return fetch(url, options);
}

// --- Helper Functions (Moved up to fix "Cannot find name" errors) ---
async function putD1Value(env, key, value) {
  const body = { key: key, value: value }; 
  await callSupabase(env, "kv_store", "POST", "", body);
}

async function getD1Value(env, key) {
  const res = await callSupabase(env, "kv_store", "GET", `?key=eq.${key}&select=value`);
  const data = await res.json();
  if (data && data.length > 0) {
    return data[0].value;
  }
  return null;
}

async function saveUser(env, userId) {
  await callSupabase(env, "users", "POST", "", { id: userId });
}

async function updateScore(env, chatId, fullName, finalScore) {
  const res = await callSupabase(env, "scores", "GET", `?user_id=eq.${chatId}`);
  const data = await res.json();
  if (data && data.length > 0) {
    const newScore = (data[0].total_score || 0) + finalScore;
    await callSupabase(env, "scores", "PATCH", `?user_id=eq.${chatId}`, { total_score: newScore, full_name: fullName });
  } else {
    await callSupabase(env, "scores", "POST", "", { user_id: chatId, full_name: fullName, total_score: finalScore });
  }
}

async function callTelegram(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TOKEN}/${method}`, { 
    method: "POST", 
    headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify(body) 
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();

        /*/ የቆዩ መልእክቶችን ችላ ለማለት
        const msgCheck = payload.message || payload.callback_query?.message;
        if (msgCheck && msgCheck.date) {
          const currentTime = Math.floor(Date.now() / 1000);
          if (currentTime - msgCheck.date > 300) { 
            return new Response("OK", { status: 200 });
          }
        }*/

        if (payload.message) {
          const chatId = payload.message.chat.id;
          const text = payload.message.text || payload.message.caption || "";
          const user = payload.message.from;
          const fullName = user.first_name || "Student";

          await saveUser(env, chatId.toString());

          // --- /start ---
          if (text.startsWith("/start")) {
            await sendStartMenu(env, chatId, null, fullName);
          } 
          
          // --- Admin: Broadcast ---
          else if (chatId.toString() === env.ADMIN_ID && text.startsWith("/broadcast")) {
            const offset = parseInt(text.split("_")[1]) || 0;
            await handleAdvancedBroadcast(env, payload.message, offset);
          }
        
          // --- Admin: Reply (ፎቶና ፋይልም ይልካል) ---
          else if (chatId.toString() === env.ADMIN_ID && text.startsWith("/reply_")) {
            const parts = text.split(" ");
            const targetId = parts[0].split("_")[1];
            const replyText = parts.slice(1).join(" ");
            
            try {
              let response;
              // 1. Reply የተደረገበት ፋይል ካለ copyMessage ይጠቀማል
              if (payload.message.reply_to_message) {
                response = await callTelegram(env, "copyMessage", {
                  chat_id: targetId,
                  from_chat_id: env.ADMIN_ID,
                  message_id: payload.message.reply_to_message.message_id
                });
                // ጽሑፍም አብሮ ካለ ለብቻው ይላካል
                if (replyText.trim().length > 0) {
                  await callTelegram(env, "sendMessage", { chat_id: targetId, text: replyText });
                }
              } 
              // 2. ጽሑፍ ብቻ ከሆነ
              else {
                response = await callTelegram(env, "sendMessage", { 
                  chat_id: targetId, 
                  text: `📩 *Message from Admin:*\n\n${replyText}`, 
                  parse_mode: "Markdown" 
                });
              }

              const result = await response.json();
              if (result.ok) {
                await callTelegram(env, "sendMessage", { chat_id: env.ADMIN_ID, text: "✅ መልእክቱ በተሳካ ሁኔታ ተልኳል።" });
              } else {
                let msg = result.description.includes("blocked") ? "🚫 ተማሪው ቦቱን Block አድርጎታል።" : "❌ አልተላከም፦ " + result.description;
                await callTelegram(env, "sendMessage", { chat_id: env.ADMIN_ID, text: msg });
              }
            } catch (e) {
              await callTelegram(env, "sendMessage", { chat_id: env.ADMIN_ID, text: "⚠️ ስህተት ተፈጥሯል።" });
            }
          }
          
          // --- User: Feedback (ሁሉንም አይነት ፋይል ይቀበላል) ---
          else if (chatId.toString() !== env.ADMIN_ID) {
            await callTelegram(env, "sendMessage", { 
              chat_id: env.ADMIN_ID, 
              text: `💬 *New Feedback from:* ${fullName}\nID: \`${chatId}\`\nReply: \`/reply_${chatId} \``, 
              parse_mode: "Markdown" 
            });

            await callTelegram(env, "copyMessage", {
              chat_id: env.ADMIN_ID,
              from_chat_id: chatId,
              message_id: payload.message.message_id
            });

            await callTelegram(env, "sendMessage", { chat_id: chatId, text: "✅ መልእክትዎ ለአስተዳዳሪው ደርሷል።" });
          }
        } 
        
        // --- እዚህ ጋር ነው Callback Query (Buttons) የሚሰሩበት ክፍል መጀመር ያለበት ---
        else if (payload.callback_query) {
          const callbackQuery = payload.callback_query;
          const chatId = callbackQuery.message.chat.id;
          const messageId = callbackQuery.message.message_id;
          const data = callbackQuery.data;
          const fullName = callbackQuery.from.first_name || "Student";

          if (data.startsWith("grade_")) {
            await sendSubjects(env, chatId, messageId, data);
          } else if (data.startsWith("units_")) {
            await sendUnits(env, chatId, messageId, data);
          } else if (data.startsWith("prequiz_")) {
            await sendPreQuizMenu(env, chatId, messageId, data);
          } else if (data.startsWith("start_")) {
            await putD1Value(env, `temp_score_${chatId}`, "0");
            await sendQuestion(env, chatId, messageId, data, 0); 
          } else if (data.startsWith("next_")) {
            const parts = data.split("_");
            const path = `grade_${parts[2]}_${parts[3]}_${parts[4]}`;
            const nextIdx = parseInt(parts[5]);
            await sendQuestion(env, chatId, messageId, `start_${path}`, nextIdx);
          } else if (data.startsWith("answer_")) {
            await handleAnswer(env, chatId, messageId, data, fullName);
          } else if (data.startsWith("seen_")) {
            await handleSeenQuestion(env, chatId, messageId, data);
          } else if (data === "contact") {
            await sendContact(env, chatId, messageId);
          } else if (data === "help") {
            await sendHelp(env, chatId, messageId);
          } else if (data === "leaderboard") {
            await sendLeaderboard(env, chatId, messageId);
          } else if (data === "back_to_main") {
            await sendStartMenu(env, chatId, messageId, fullName);
          } else if (data.startsWith("back_to_grade_")) {
            await sendSubjects(env, chatId, messageId, data.replace("back_to_grade_", ""));
          } else if (data.startsWith("back_to_units_")) {
             const parts = data.split("_");
             const reconstructedData = `units_${parts[3]}_${parts[4]}_${parts[5]}`;
             await sendUnits(env, chatId, messageId, reconstructedData);
          }
          
          // Telegram 'loading' icon እንዲቆም
          await callTelegram(env, "answerCallbackQuery", { callback_query_id: callbackQuery.id });
        }

      } catch (e) {
        return new Response("OK", { status: 200 });
      }
      return new Response("OK", { status: 200 });
    }
    return new Response("Bot is active!");
  },
};



// --- GUI Functions ---
async function sendStartMenu(env, chatId, editMessageId = null, fullName = "Student") {
  const welcomeText = `*👋 Hello student!*\n\n
Are you ready to test your knowledge? Select your grade level below and start practicing right now! 🚀"`;
  const keyboard = [
    [{ text: "📚 Grade 9", callback_data: "grade_9" }, { text: "📚 Grade 10", callback_data: "grade_10" }],
    [{ text: "📚 Grade 11", callback_data: "grade_11" }, { text: "📚 Grade 12", callback_data: "grade_12" }],
    [{ text: "🏆 Leaderboard", callback_data: "leaderboard" }, { text: "👤 My Score", callback_data: "my_score" }], // My Score እዚህ ተጨመረ
    [{ text: " 🙏 Ask Smart-X ", callback_data: "contact" }, { text: "❓ Help ", callback_data: "help" }]
  ];
  
  const method = editMessageId ? "editMessageText" : "sendMessage";
  const body = { chat_id: chatId, text: welcomeText, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } };
  if (editMessageId) body.message_id = editMessageId;
  await callTelegram(env, method, body);
}

async function sendQuestion(env, chatId, messageId, data, questionIndex) {
  const path = data.replace("start_", "quiz_"); 
  const quizDataRaw = await getD1Value(env, path);
  if (!quizDataRaw) {
    await callTelegram(env, "answerCallbackQuery", { callback_query_id: messageId, text: "Error: Quiz data not found!", show_alert: true });
    return;
  }
  const questions = typeof quizDataRaw === 'string' ? JSON.parse(quizDataRaw) : quizDataRaw;
  if (questionIndex >= questions.length || questionIndex < 0) {
    const rawScore = await getD1Value(env, `temp_score_${chatId}`);
     const finalScore = (rawScore !== null) ? parseInt(rawScore) : 0;
    
    const user = await callTelegram(env, "getChat", { chat_id: chatId });
    const userJson = await user.json();
    const fullName = userJson.ok ? (userJson.result.first_name || "Student") : "Student";

    if (finalScore > 0) {
        await updateScore(env, chatId.toString(), fullName, finalScore);
    }

    await callTelegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: `🎉 **Unit Completed!**\n\n🎯 Score: *${finalScore}/${questions.length}*\nCheck the Leaderboard to see your standing! 🏆`,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Main Menu", callback_data: "back_to_main" }]] }
    });
    await putD1Value(env, `temp_score_${chatId}`, "0");
    return;
  }
  const q = questions[questionIndex];
  const labels = ["A", "B", "C", "D"];
  let formattedText = `*Question ${questionIndex + 1}/${questions.length}*\n\n${q.question}\n\n`;
  q.options.forEach((opt, idx) => { formattedText += `*${labels[idx]}.* ${opt}\n`; });
  const keyboard = [ labels.map((label, idx) => ({ text: label, callback_data: `answer_${path}_${questionIndex}_${idx}` })) ];
  await callTelegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: formattedText, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function handleAnswer(env, chatId, messageId, data, fullName) {
  const parts = data.split("_");
  const path = `${parts[2]}_${parts[3]}_${parts[4]}_${parts[5]}`;
  const currentIndex = parseInt(parts[6]);
  const userChoice = parseInt(parts[7]);
  const quizData = await getD1Value(env, `quiz_${path}`);
  if (!quizData) return;
  const questions = typeof quizData === 'string' ? JSON.parse(quizData) : quizData;
  const q = questions[currentIndex];
  const isCorrect = userChoice === q.correct;
  
  if (isCorrect) {
    const rawScore = await getD1Value(env, `temp_score_${chatId}`);
    let currentTemp = (rawScore !== null) ? parseInt(rawScore) : 0;
    currentTemp++;
    await putD1Value(env, `temp_score_${chatId}`, currentTemp.toString());
  }
  
  const feedbackText = isCorrect ? `✅ **Correct!**\n\n${q.explanation}` : `❌ **Incorrect!**\n\nThe correct answer was: *${q.options[q.correct]}*\n\n${q.explanation}`;
  let keyboard = [[{ text: "Next ➡️", callback_data: `next_${path}_${currentIndex + 1}` }], [{ text: "👁 Seen Question", callback_data: `seen_${path}_${currentIndex}` }, { text: "🏠 Home", callback_data: "back_to_main" }]];
  await callTelegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: feedbackText, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function handleSeenQuestion(env, chatId, messageId, data) {
  const parts = data.split("_");
  const path = `${parts[1]}_${parts[2]}_${parts[3]}_${parts[4]}`;
  const currentIndex = parseInt(parts[5]);
  const quizData = await getD1Value(env, `quiz_${path}`);
  if (!quizData) return;
  const questions = typeof quizData === 'string' ? JSON.parse(quizData) : quizData;
  const q = questions[currentIndex];
  const labels = ["A", "B", "C", "D"];
  let formattedText = `*Review Question ${currentIndex + 1}*\n\n${q.question}\n\n`;
  q.options.forEach((opt, idx) => { formattedText += `${idx === q.correct ? "✅" : "🔹"} *${labels[idx]}.* ${opt}\n`; });
  let keyboard = [[{ text: "⬅️ Back to explain ", callback_data: `answer_quiz_${path}_${currentIndex}_-1` }], [{ text: "Next ➡️", callback_data: `next_${path}_${currentIndex + 1}` }]];
  await callTelegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: formattedText, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function sendMyScore(env, chatId, messageId, fullName) {
  try {
    // 1. የተማሪውን ውጤት ማምጣት
    const userRes = await callSupabase(env, "scores", "GET", `?user_id=eq.${chatId}&select=total_score`);
    const userData = await userRes.json();
    
    if (!userData || userData.length === 0 || userData[0].total_score === 0) {
      await callTelegram(env, "editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: `👋 *${fullName}*\n\nገና ምንም ጥያቄ አልሰራህም፤ ፈተናዎችን ስትሰራ ውጤትህ እዚህ ይታያል! 💪`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: "back_to_main" }]] }
      });
      return;
    }

    const myScore = userData[0].total_score;

    // 2. ከእሱ በላይ የተሻለ ውጤት ያላቸውን ተማሪዎች ብዛት መቆጠር (ደረጃውን ለማወቅ)
    const rankRes = await callSupabase(env, "scores", "GET", `?total_score=gt.${myScore}&select=count`, "HEAD");
    // ማሳሰቢያ፡ Supabase 'count' በ header ውስጥ ነው የሚመልሰው ወይም 'select=count' መጠቀም ይቻላል
    // በቀላሉ ለማድረግ ሁሉንም አምጥቶ መቁጠር ወይም የተለየ ኳየሪ መጠቀም ይቻላል። 
    // እዚህ ጋር ቀለል ባለ መንገድ ሁሉንም ውጤቶች አምጥተን ደረጃውን እንፈልግ፡
    
    const allRes = await callSupabase(env, "scores", "GET", "?select=user_id&order=total_score.desc");
    const allData = await allRes.json();
    
    const rank = allData.findIndex(u => u.user_id === chatId.toString()) + 1;

    const scoreText = `👤 **የእርስዎ መረጃ (My Profile)**\n` +
                      `__________________________________\n\n` +
                      `📝 ስም፦ *${fullName}*\n` +
                      `🎯 አጠቃላይ ውጤት፦ \`${myScore}\` ነጥብ\n` +
                      `🏆 ደረጃ፦ \`#${rank}\` ከ ${allData.length} ተማሪዎች\n\n` +
                      `__________________________________\n` +
                      `ተጨማሪ ጥያቄዎችን በመስራት ደረጃዎን ያሻሽሉ! 🚀`;

    await callTelegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: scoreText,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [[{ text: "🔙 Back to Main Menu", callback_data: "back_to_main" }]] }
    });
  } catch (e) {
    await callTelegram(env, "sendMessage", { chat_id: chatId, text: "⚠️ መረጃውን ማምጣት አልተቻለም።" });
  }
}

/*async function handleAdvancedBroadcast(env, originalMsg, offset) {
  // 1. ተጠቃሚዎችን ከ Supabase ማምጣት
  const res = await callSupabase(env, "users", "GET", `?select=id&limit=500&offset=${offset}`);
  const results = await res.json();

  if (!results || results.length === 0) {
    await callTelegram(env, "sendMessage", { 
      chat_id: env.ADMIN_ID, 
      text: "✅ **ብሮድካስቱ ተጠናቋል።** ተጨማሪ ተጠቃሚ በዝርዝሩ ውስጥ የለም።",
      parse_mode: "Markdown"
    });
    return;
  }

  let success = 0;
  let fail = 0;
  let blocked = 0;

  // 2. የሚላከውን ጽሑፍ ማዘጋጀት (Syntax Error እንዳይመጣ ተስተካክሏል)
  const rawText = originalMsg.text || originalMsg.caption || "";
  const cleanText = rawText.replace(/\/broadcast(_\d+)?\s*, "").trim();

  /*3. ለእያንዳንዱ ተጠቃሚ መላክ
  for (const user of results) {
    try {
      let response;
      let body = { 
        chat_id: user.id, 
        caption: cleanText, 
        parse_mode: "Markdown" 
      };

      // --- የፋይል አይነቱን ለይቶ መላክ ---
      
      // ሀ. ቪዲዮ ከሆነ
      if (originalMsg.video) {
        body.video = originalMsg.video.file_id;
        response = await callTelegram(env, "sendVideo", body);
      } 
      // ለ. PDF ወይም ሌላ ፋይል ከሆነ
      else if (originalMsg.document) {
        body.document = originalMsg.document.file_id;
        response = await callTelegram(env, "sendDocument", body);
      } 
      // ሐ. ፎቶ ከሆነ
      else if (originalMsg.photo) {
        body.photo = originalMsg.photo[originalMsg.photo.length - 1].file_id;
        response = await callTelegram(env, "sendPhoto", body);
      } 
      // መ. ኦዲዮ ከሆነ
      else if (originalMsg.audio) {
        body.audio = originalMsg.audio.file_id;
        response = await callTelegram(env, "sendAudio", body);
      }
      // ሠ. ጽሑፍ ብቻ ከሆነ
      else {
        response = await callTelegram(env, "sendMessage", { 
          chat_id: user.id, 
          text: cleanText, 
          parse_mode: "Markdown" 
        });
      }

      const outcome = await response.json();
      if (outcome.ok) {
        success++;
      } else {
        // ቦቱን የዘጉ ተጠቃሚዎችን መለየት
        if (outcome.description && outcome.description.includes("blocked")) {
          blocked++;
        }
        fail++;
      }
    } catch (e) { 
      fail++; 
    }

    // በየ 30 መልእክቱ Telegram እንዳያግደን 1 ሰከንድ እረፍት መስጠት (Anti-Spam)
    if ((success + fail) % 30 === 0) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 4. ዝርዝር ሪፖርት ለአስተዳዳሪው መላክ
  const reportMsg = `📊 **የብሮድካስት ሪፖርት (Batch: ${offset})**\n\n` +
                    `✅ በተሳካ ሁኔታ የተላከ፡ ${success}\n` +
                    `🚫 ቦቱን የዘጉ (Blocked)፡ ${blocked}\n` +
                    `❌ ያልተላከላቸው (ሌላ ስህተት)፡ ${fail - blocked}\n` +
                    `📉 ጠቅላላ ሙከራ፡ ${success + fail}\n\n` +
                    `ቀጣዩን 500 ለመላክ፦ \`/broadcast_${offset + 500} ${cleanText}\``;

  await callTelegram(env, "sendMessage", { 
    chat_id: env.ADMIN_ID, 
    text: reportMsg, 
    parse_mode: "Markdown" 
  });
}*/
async function handleAdvancedBroadcast(env, originalMsg, offset) {
  // በአንድ ጊዜ የሚላክላቸው ተጠቃሚዎች ብዛት (Timeout እንዳይፈጠር 50 ተመራጭ ነው)
  const BATCH_SIZE = 50; 
  
  // 1. ተጠቃሚዎችን ከ Supabase ማምጣት
  const res = await callSupabase(env, "users", "GET", `?select=id&limit=${BATCH_SIZE}&offset=${offset}`);
  const results = await res.json();

  // ተጠቃሚ ካለቀ ብሮድካስቱ መቆሙን ይነግረናል
  if (!results || results.length === 0) {
    await callTelegram(env, "sendMessage", { 
      chat_id: env.ADMIN_ID, 
      text: "✅ **ብሮድካስቱ ተጠናቋል።** በዝርዝሩ ውስጥ የቀረ ተጨማሪ ተጠቃሚ የለም።",
      parse_mode: "Markdown"
    });
    return;
  }

  let success = 0;
  let blocked = 0;
  let failed = 0;

  // 2. የሚላከውን ጽሑፍ ማዘጋጀት
  const rawText = originalMsg.text || originalMsg.caption || "";
  const cleanText = rawText.replace(/\/broadcast(_\d+)?\s*/, "").trim();
  

  // 3. ለእያንዳንዱ ተጠቃሚ መላክ (Loop)
  for (const user of results) {
    try {
      let response;
      let body = { 
        chat_id: user.id, 
        caption: cleanText, 
        parse_mode: "Markdown" 
      };

      // የፋይል አይነቱን ለይቶ መላክ
      if (originalMsg.video) {
        body.video = originalMsg.video.file_id;
        response = await callTelegram(env, "sendVideo", body);
      } 
      else if (originalMsg.document) {
        body.document = originalMsg.document.file_id;
        response = await callTelegram(env, "sendDocument", body);
      } 
      else if (originalMsg.photo) {
        body.photo = originalMsg.photo[originalMsg.photo.length - 1].file_id;
        response = await callTelegram(env, "sendPhoto", body);
      } 
      else if (originalMsg.audio) {
        body.audio = originalMsg.audio.file_id;
        response = await callTelegram(env, "sendAudio", body);
      }
      else {
        response = await callTelegram(env, "sendMessage", { 
          chat_id: user.id, 
          text: cleanText, 
          parse_mode: "Markdown" 
        });
      }

      const outcome = await response.json();
      if (outcome.ok) {
        success++;
      } else {
        // ቦቱን የዘጉ ተጠቃሚዎችን መለየት
        if (outcome.description && outcome.description.includes("blocked")) {
          blocked++;
        }
        failed++;
      }
    } catch (e) { 
      failed++; 
    }

    // ቴሌግራም ፍጥነታችንን ገድቦ (Rate Limit) እንዳያግደን ትንሽ እረፍት (Anti-Spam)
    await new Promise(r => setTimeout(r, 60)); 
  }

  // 4. ዝርዝር ሪፖርት ለአስተዳዳሪው መላክ
  const nextOffset = offset + results.length;
  const reportMsg = `📊 **የብሮድካስት ሪፖርት (Batch: ${offset} - ${nextOffset})**\n\n` +
                    `✅ በተሳካ ሁኔታ የተላከ፡ \`${success}\`\n` +
                    `🚫 ቦቱን የዘጉ (Blocked)፡ \`${blocked}\`\n` +
                    `❌ ያልተላከላቸው (ሌላ ስህተት)፡ \`${failed - blocked}\`\n` +
                    `📉 በዚህ ዙር የተሞከረ፡ \`${success + failed}\`\n\n` +
                    `⚠️ **ማሳሰቢያ፦** ተጠቃሚዎችህ ከ ${BATCH_SIZE} በላይ ስለሆኑ ቀጣዩን ለመላክ ከታች ያለውን ሊንክ ይጫኑ።\n\n` +
                    `👇 **ቀጣዩን ለመላክ ይህን ይጫኑ፦**\n` +
                    `\`/broadcast_${nextOffset} ${cleanText}\``;

  await callTelegram(env, "sendMessage", { 
    chat_id: env.ADMIN_ID, 
    text: reportMsg, 
    parse_mode: "Markdown" 
  });
}

async function sendSubjects(env, chatId, messageId, grade) {
  const subjectMap = {
    grade_9: [["Physics", "History"], ["Biology", "Economics"], ["Chemistry", "Geography"], ["English",]],
    grade_10: [["Physics", "History"], ["Biology", "Economics"], ["Chemistry", "Geography"], ["English",]],
    grade_11: [["Physics", "History"], ["Biology", "Economics"], ["Chemistry", "Geography"], ["English",]],
    grade_12: [["Physics", "History"], ["Biology", "Economics"], ["Chemistry", "Geography"], ["English"]]
  };

  const subjects = subjectMap[grade] || [];
  
  // አዝራሮቹ እንደነበሩ በጎን እና በጎን (Two Columns) እንዲሆኑ ተደርጓል
  let keyboard = subjects.map(row => row.map(subName => ({ 
    text: subName, 
    callback_data: `units_${grade}_${subName.toLowerCase().trim().substring(0, 4)}` 
  })));

  keyboard.push([{ text: "🔙 Back to Main Menu", callback_data: "back_to_main" }]);

  const gradeTitle = grade.replace("_", " ").toUpperCase();

  // የአማርኛው መመሪያ እዚህ ጋር ተካቷል
  const instructionText = `📂 **${gradeTitle}**\n\nPlease select the subject you would like to be tested on.`;

  await callTelegram(env, "editMessageText", { 
    chat_id: chatId, 
    message_id: messageId, 
    text: instructionText, 
    parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: keyboard } 
  });
}

const UNIT_COUNTS = {
  // Grade 9
  "grade_9_phys": 7, "grade_9_hist": 9, "grade_9_biol": 6, "grade_9_econ": 8,
  "grade_9_chem": 5, "grade_9_geog": 8, "grade_9_engl": 10, "grade_9_citi": 7,
  
  // Grade 10
  "grade_10_phys": 6, "grade_10_hist": 9, "grade_10_biol": 6, "grade_10_econ": 8,
  "grade_10_chem": 6, "grade_10_geog": 8, "grade_10_engl": 10, "grade_10_citi": 8,

  // Grade 11
  "grade_11_phys": 8, "grade_11_hist": 8, "grade_11_biol": 7, "grade_11_econ": 7,
  "grade_11_chem": 8, "grade_11_geog": 8, "grade_11_engl": 12, "grade_11_agri": 6,

  // Grade 12
  "grade_12_phys": 8, "grade_12_hist": 8, "grade_12_biol": 7, "grade_12_econ": 7,
  "grade_12_chem": 8, "grade_12_geog": 8, "grade_12_engl": 12, "grade_12_agri": 6
};


// 2. የተስተካከለው sendUnits Function
async function sendUnits(env, chatId, messageId, data) {
  const parts = data.split("_");
  const gradeKey = parts[1] + "_" + parts[2]; // e.g., grade_9
  const sub = parts[3]; // e.g., phys
  const fullKey = `${gradeKey}_${sub}`;

  // የዩኒት ብዛቱን ከላይ ካለው ዝርዝር ይፈልጋል፣ ከሌለ በነባሪ 6 ያደርጋል
  const unitCount = UNIT_COUNTS[fullKey] || 6;

  let keyboard = [];
  let row = [];

  for (let i = 1; i <= unitCount; i++) {
    // አዝራሮቹን መፍጠር
    row.push({ 
      text: `📖 Unit ${i}`, 
      callback_data: `prequiz_${gradeKey}_${sub}_${i}` 
    });
    
    // በየመስመሩ 2 አዝራር እንዲሆን መቆጣጠር
    if (row.length === 2) {
      keyboard.push(row);
      row = [];
    }
  }
  
  // ትርፍ (ነጠላ) አዝራር ካለ መጨመሪያ
  if (row.length > 0) {
    keyboard.push(row);
  }

  // ወደ ኋላ መመለሻ አዝራር (ሙሉ ስክሪን እንዲይዝ በራሱ መስመር)
  keyboard.push([{ text: "🔙 Back to Subjects", callback_data: `back_to_grade_${gradeKey}` }]);

  const title = gradeKey.replace("_", " ").toUpperCase();
  const subjectName = sub.toUpperCase();

  await callTelegram(env, "editMessageText", { 
    chat_id: chatId, 
    message_id: messageId, 
    text: `📂 *${title} > ${subjectName}*\n\n Please select the unit you would like to test.:`, 
    parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: keyboard } 
  });
}
async function sendPreQuizMenu(env, chatId, messageId, data) {
  const parts = data.split("_");
  let keyboard = [[{ text: "🚀 Start Quiz", callback_data: `start_${data.replace("prequiz_", "")}` }], [{ text: "🔙 Back", callback_data: `back_to_units_${parts[1]}_${parts[2]}_${parts[3]}` }]];
  await callTelegram(env, "editMessageText", { chat_id: chatId, message_id: messageId, text: `📝 *Quiz Information*\n\n📍 Grade: ${parts[1]} ${parts[2]}\n📚 Subject: ${parts[3].toUpperCase()}\nReady?`, parse_mode: "Markdown", reply_markup: { inline_keyboard: keyboard } });
}

async function sendLeaderboard(env, chatId, messageId) {
  try {
    const res = await callSupabase(env, "scores", "GET", "?select=full_name,total_score&total_score=gt.0&order=total_score.desc&limit=10");
    const results = await res.json();
    
    let leaderText = "🏆 **የተማሪዎች የደረጃ ሰንጠረዥ (Top 10)** 🏆\n";
    leaderText += "__________________________________\n\n";

    if (results && results.length > 0) {
      results.forEach((row, index) => {
        let medal = "";
        // የመጀመሪያዎቹን ሦስት ደረጃዎች በሜዳሊያ መለየት
        if (index === 0) medal = "🥇 ";
        else if (index === 1) medal = "🥈 ";
        else if (index === 2) medal = "🥉 ";
        else medal = `${index + 1}. `;

        leaderText += `${medal}**${row.full_name}**\n      └ 🎯 ውጤት: \`${row.total_score}\` ነጥብ\n\n`;
      });
      
      leaderText += "__________________________________\n";
      leaderText += "💪 በርቱ! እናንተም ጠንክራችሁ በመስራት እዚህ ዝርዝር ውስጥ መግባት ትችላላችሁ።";
    } else {
      leaderText += "በአሁኑ ሰዓት ምንም የተመዘገበ ውጤት የለም። የመጀመሪያው ተማሪ ይሁኑ!";
    }

    await callTelegram(env, "editMessageText", { 
      chat_id: chatId, 
      message_id: messageId, 
      text: leaderText, 
      parse_mode: "Markdown", 
      reply_markup: { 
        inline_keyboard: [[{ text: "🔙 back to main ", callback_data: "back_to_main" }]] 
      } 
    });
  } catch (e) { 
    await callTelegram(env, "sendMessage", { chat_id: chatId, text: "⚠️ የደረጃ ሰንጠረዡን መጫን አልተቻለም። እባክዎ ቆይተው ይሞክሩ።" }); 
  }
}
async function sendContact(env, chatId, messageId) {
  const contactText = `📩 **Contact & Support | እኛን ለማግኘት**\n\n` +
    `🤖 **ለአስተዳዳሪው መልእክት ለመላክ:**\n` +
    `ከታች ያለውን "📩 Send Message" የሚለውን ቁልፍ በመጫን ቀጥታ ያግኙን።\n\n` +
    `📞 **በስልክ ለመደወል:**\n` +
    `+251992480372\n\n` +
    `⏰ **የመደወያ ሰዓታት (Working Hours):**\n` +
    `• **ከሰኞ - አርብ:** ከቀኑ 11:00 - 1:00 ሰዓት\n` +
    `• **ቅዳሜ እና እሁድ:** ሙሉ ቀን መደወል ይቻላል\n\n` +
    `🙏 ማንኛውንም ጥያቄ ወይም አስተያየት ካለዎት ለመቀበል ዝግጁ ነን!`;

  const keyboard = [
    // ቀጥታ ወደ አንተ አካውንት የሚወስድ ሊንክ (Usernameህን እዚህ ጋር ቀይረው)
    [{ text: "📩 Send Message to Admin", url: "https://t.me/TalkToHabtamuBot" }], 
    [{ text: "🔙 Back to Main Menu", callback_data: "back_to_main" }]
  ];

  await callTelegram(env, "editMessageText", { 
    chat_id: chatId, 
    message_id: messageId, 
    text: contactText, 
    parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: keyboard } 
  });
}

async function sendHelp(env, chatId, messageId) {
  const helpText = `❓ **የቦቱ አጠቃቀም መመሪያ (Step-by-Step Guide)**\n\n` +
    `እንኳን ወደ ፈተና ዝግጅት ቦታችን በሰላም መጡ! ይህ ቦት ከክፍል 9-12 ያሉ ተማሪዎች ለብሔራዊ እና ለክፍል ውስጥ ፈተናዎች ራሳቸውን እንዲያዘጋጁ ይረዳል።\n\n` +
    `📍 **ቦቱን ለመጠቀም እነዚህን ቅደም ተከተሎች ይከተሉ፡**\n\n` +
    `1️⃣ **ክፍልዎን ይምረጡ (Select Grade):**\n` +
    `በመጀመሪያ በዋናው ማውጫ ላይ የራስዎን የክፍል ደረጃ (ለምሳሌ Grade 12) ይምረጡ።\n\n` +
    `2️⃣ **ትምህርት ይምረጡ (Select Subject):**\n` +
    `ክፍልዎን ከመረጡ በኋላ፣ መለማመድ የሚፈልጉትን የትምህርት አይነት (ለምሳሌ Physics ወይም Biology) ይምረጡ።\n\n` +
    `3️⃣ **ዩኒት ይምረጡ (Select Unit):**\n` +
    `በመረጡት ትምህርት ስር ያሉትን ዩኒቶች ዝርዝር ያገኛሉ። መፈተን የሚፈልጉትን ዩኒት ይጫኑ።\n\n` +
    `4️⃣ **ፈተናውን ይጀምሩ (Start Quiz):**\n` +
    `"🚀 Start Quiz" የሚለውን ቁልፍ ሲጫኑ ጥያቄዎቹ አንድ በአንድ ይመጡልዎታል። ትክክለኛ የመሰለዎትን ምርጫ (A, B, C, D) ይምረጡ።\n\n` +
    `5️⃣ **ውጤትዎን ይመልከቱ (Check Score):**\n` +
    `ለእያንዳንዱ ጥያቄ መልስ ሲሰጡ፣ መልሱ ትክክል መሆኑን እና ዝርዝር ማብራሪያውን ያገኛሉ። ፈተናውን ሲጨርሱ አጠቃላይ ውጤትዎ ይነግርዎታል።\n\n` +
    `6️⃣ **ደረጃዎን ይመልከቱ (Leaderboard):**\n` +
    `በዋናው ማውጫ ላይ "🏆 Leaderboard" የሚለውን በመጫን በውጤትዎ ከሌሎች ተማሪዎች ጋር ያለዎትን ደረጃ ማየት ይችላሉ።\n\n` +
    `⚠️ **ተጨማሪ መረጃ፡**\n` +
    `መልእክትዎ ለአስተዳዳሪው እንዲደርስ ከፈለጉ፣ ማንኛውንም ጽሑፍ በቦቱ ላይ ይጻፉ። አስተዳዳሪው ሲመልስልዎ እዚሁ ቦት ላይ መልእክት ይደርስዎታል።\n\n` +
    `መልካም ጥናት! 📚✨`;

  const keyboard = [
    [{ text: " 🔙 back to main", callback_data: "back_to_main" }]
  ];

  await callTelegram(env, "editMessageText", { 
    chat_id: chatId, 
    message_id: messageId, 
    text: helpText, 
    parse_mode: "Markdown", 
    reply_markup: { inline_keyboard: keyboard } 
  });
}
