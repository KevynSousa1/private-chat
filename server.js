const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const webPush = require('web-push');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Serve index.html and sw.js from the same directory
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'sw.js'));
});

// Configure VAPID keys for push notifications
webPush.setVapidDetails(
    'mailto:your-email@example.com', // Replace with your email
    process.env.VAPID_PUBLIC_KEY, // Set in Render environment variables
    process.env.VAPID_PRIVATE_KEY // Set in Render environment variables
);

const chats = {}; // { chatId: { chatCode, userCode, chatName, users: [{ userId, username, pushSubscription }], sockets } }
const chatCodeToChatId = {}; // { chatCode: chatId }
const userCodeToChatId = {}; // { userCode: chatId }

io.on('connection', (socket) => {
    socket.on('createChat', ({ userId, username }) => {
        const chatId = uuidv4();
        const chatCode = uuidv4().substring(0, 8);
        const userCode = uuidv4().substring(0, 8);
        const chatName = 'Private Chat';
        chats[chatId] = { 
            chatCode, 
            userCode, 
            chatName,
            users: [{ userId, username: username || 'Anonymous', pushSubscription: null }], 
            sockets: [socket.id] 
        };
        chatCodeToChatId[chatCode] = chatId;
        userCodeToChatId[userCode] = chatId;
        socket.join(chatId);
        socket.emit('chatCreated', { chatId, chatCode, userCode, chatName });
    });

    socket.on('joinChat', ({ chatCode, userCode, userId, username }) => {
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
        if (!chats[chatId].users.some(u => u.userId === userId)) {
            chats[chatId].users.push({ userId, username: username || 'Anonymous', pushSubscription: null });
            chats[chatId].sockets.push(socket.id);
        }
        socket.join(chatId);
        io.to(chatId).emit('userOnline', { userId, username: username || 'Anonymous' });
        socket.emit('chatJoined', { chatId, users: chats[chatId].users, chatName: chats[chatId].chatName });
    });

    socket.on('setUsername', ({ chatId, userId, username }) => {
        if (chats[chatId]) {
            const user = chats[chatId].users.find(u => u.userId === userId);
            if (user) {
                user.username = username;
                io.to(chatId).emit('userOnline', { userId, username });
            }
        }
    });

    socket.on('setChatName', ({ chatId, chatName }) => {
        if (chats[chatId] && chatName.trim()) {
            chats[chatId].chatName = chatName.substring(0, 50);
            io.to(chatId).emit('chatNameUpdated', { chatName: chats[chatId].chatName });
        }
    });

    socket.on('subscribePush', ({ userId, subscription, chatId }) => {
        if (chats[chatId]) {
            const user = chats[chatId].users.find(u => u.userId === userId);
            if (user) {
                user.pushSubscription = subscription;
            }
        }
    });

    socket.on('sendMessage', async (msgData) => {
        io.to(msgData.chatId).emit('message', msgData);
        // Send push notifications to offline users
        if (chats[msgData.chatId]) {
            for (const user of chats[msgData.chatId].users) {
                if (user.userId !== msgData.userId && user.pushSubscription) {
                    const payload = JSON.stringify({
                        title: `${msgData.username || 'Anonymous'} in ${chats[msgData.chatId].chatName}`,
                        body: msgData.fileUrl ? 'Sent a file' : (msgData.message.substring(0, 50) + (msgData.message.length > 50 ? '...' : '')),
                        url: `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'your-app.onrender.com'}`
                    });
                    try {
                        await webPush.sendNotification(user.pushSubscription, payload);
                    } catch (error) {
                        console.error('Failed to send push notification:', error);
                        user.pushSubscription = null; // Remove invalid subscription
                    }
                }
            }
        }
    });

    socket.on('disconnect', () => {
        for (const chatId in chats) {
            const chat = chats[chatId];
            const userIndex = chat.sockets.indexOf(socket.id);
            if (userIndex !== -1) {
                const user = chat.users[userIndex];
                chat.sockets.splice(userIndex, 1);
                chat.users.splice(userIndex, 1);
                io.to(chatId).emit('userOffline', { userId: user.userId, username: user.username });
                if (chat.sockets.length === 0) {
                    delete chatCodeToChatId[chat.chatCode];
                    delete userCodeToChatId[chat.userCode];
                    delete chats[chatId];
                }
            }
        }
    });
});

// Use Render's assigned port or default to 3000 for local testing
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
