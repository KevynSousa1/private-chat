const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Serve index.html from the same directory as server.js
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const chats = {}; // { chatId: { chatCode, userCode, users, sockets } }
const chatCodeToChatId = {}; // { chatCode: chatId }
const userCodeToChatId = {}; // { userCode: chatId }

io.on('connection', (socket) => {
    socket.on('createChat', ({ userId }) => {
        const chatId = uuidv4();
        const chatCode = uuidv4().substring(0, 8); // Shortened UUID for chat
        const userCode = uuidv4().substring(0, 8); // Shortened UUID for user
        chats[chatId] = { chatCode, userCode, users: [userId], sockets: [socket.id] };
        chatCodeToChatId[chatCode] = chatId;
        userCodeToChatId[userCode] = chatId;
        socket.join(chatId);
        socket.emit('chatCreated', { chatId, chatCode, userCode });
    });

    socket.on('joinChat', ({ chatCode, userCode, userId }) => {
        const chatId = chatCodeToChatId[chatCode];
        if (!chatId || !chats[chatId]) {
            socket.emit('error', 'Invalid or expired chat code.');
            return;
        }
        if (chats[chatId].userCode !== userCode) {
            socket.emit('error', 'Invalid user code.');
            return;
        }
        if (chats[chatId].users.length >= 3) {
            socket.emit('error', 'Chat room is full.');
            return;
        }
        if (!chats[chatId].users.includes(userId)) {
            chats[chatId].users.push(userId);
            chats[chatId].sockets.push(socket.id);
        }
        socket.join(chatId);
        socket.emit('chatJoined', { chatId });
    });

    socket.on('sendMessage', (msgData) => {
        io.to(msgData.chatId).emit('message', msgData);
    });

    socket.on('disconnect', () => {
        for (const chatId in chats) {
            const chat = chats[chatId];
            chat.sockets = chat.sockets.filter(id => id !== socket.id);
            if (chat.sockets.length === 0) {
                delete chatCodeToChatId[chat.chatCode];
                delete userCodeToChatId[chat.userCode];
                delete chats[chatId];
            }
        }
    });
});

// Use Render's assigned port or default to 3000 for local testing
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});