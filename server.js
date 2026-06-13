const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 数据库初始化
const db = new sqlite3.Database('./guess_game.db', (err) => {
    if (err) console.error('数据库连接失败:', err);
    else console.log('数据库连接成功');
});

// 创建表
db.serialize(() => {
    // 用户表（添加管理员权限字段）
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        nickname TEXT NOT NULL,
        total_score INTEGER DEFAULT 0,
        season_score INTEGER DEFAULT 0,
        current_season TEXT NOT NULL,
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // 兼容旧数据库：添加is_admin字段
    db.run(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`, (err) => {});

    // 猜词记录表
    db.run(`CREATE TABLE IF NOT EXISTS guess_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        target_word TEXT NOT NULL,
        guess_word TEXT NOT NULL,
        similarity INTEGER NOT NULL,
        used_time INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`);
});

// 段位配置（细分小段位）
const levels = [
    {name: "青铜Ⅲ", min: 0, max: 1},
    {name: "青铜Ⅱ", min: 2, max: 3},
    {name: "青铜Ⅰ", min: 4, max: 5},
    {name: "白银Ⅲ", min: 6, max: 8},
    {name: "白银Ⅱ", min: 9, max: 11},
    {name: "白银Ⅰ", min: 12, max: 15},
    {name: "黄金Ⅲ", min: 16, max: 20},
    {name: "黄金Ⅱ", min: 21, max: 25},
    {name: "黄金Ⅰ", min: 26, max: 30},
    {name: "钻石Ⅲ", min: 31, max: 40},
    {name: "钻石Ⅱ", min: 41, max: 50},
    {name: "钻石Ⅰ", min: 51, max: 9999}
];

// 获取当前赛季（每年第N周，每周一重置）
function getCurrentSeason() {
    const now = new Date();
    const firstDayOfYear = new Date(now.getFullYear(), 0, 1);
    const pastDaysOfYear = (now - firstDayOfYear) / 86400000;
    const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    return `${now.getFullYear()}-${weekNum}`;
}

// 计算段位
function getLevel(score) {
    for (let level of levels) {
        if (score >= level.min && score <= level.max) {
            return level.name;
        }
    }
    return "钻石Ⅰ";
}

// ====================== 核心：真实大模型智能语义相关度判断 ======================
// 豆包大模型API配置
const DOUBAO_API_KEY = "191b8b3e-1141-4e63-850f-57d40482082f";
const DOUBAO_MODEL = "ep-20250613151228-q5wqz";

// 调用豆包大模型进行语义相似度判断
async function aiCalcSimilarity(guessWord, targetWord, category) {
    // 完全匹配直接返回
    if (guessWord === targetWord) return 100;
    
    // 包含关系
    if (guessWord.includes(targetWord) || targetWord.includes(guessWord)) return 85;

    try {
        // 调用大模型API
        const response = await fetch(`https://ark.cn-beijing.volces.com/api/v3/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DOUBAO_API_KEY}`
            },
            body: JSON.stringify({
                model: DOUBAO_MODEL,
                messages: [
                    {
                        role: "system",
                        content: `你是一个语义相似度判断专家。请判断词语"${guessWord}"和目标词语"${targetWord}"的语义关联程度，属于${category}大类。
                        输出要求：只输出一个0-99之间的整数数字，不要输出任何其他内容。
                        判断标准：
                        - 80-99：语义高度相关，直接近义词或强关联
                        - 50-79：语义中度相关，同领域或有明显关联
                        - 20-49：语义低度相关，弱关联或同大类
                        - 0-19：几乎不相关`
                    },
                    {
                        role: "user",
                        content: `判断"${guessWord}"和"${targetWord}"的语义相关度`
                    }
                ],
                temperature: 0.1,
                max_tokens: 10
            })
        });

        const data = await response.json();
        const result = data.choices[0].message.content.trim();
        const similarity = parseInt(result);
        
        // 校验返回值
        if (!isNaN(similarity) && similarity >= 0 && similarity <= 99) {
            return similarity;
        }
    } catch (e) {
        console.log("大模型调用失败，使用备用算法:", e.message);
    }

    // 备用算法（API调用失败时使用）
    const semanticKB = {
        "太阳": {high: ["阳光", "日光", "晴天", "日出", "日落"], medium: ["天空", "白天", "光明", "温暖"]},
        "月亮": {high: ["月光", "月色", "月圆"], medium: ["夜晚", "星星", "天空", "中秋"]},
        "星星": {high: ["星光", "星辰", "星座"], medium: ["夜空", "月亮", "天空", "银河"]},
        "大海": {high: ["海洋", "海水", "海浪", "沙滩"], medium: ["蓝色", "鲸鱼", "海豚"]},
        "梦想": {high: ["理想", "目标", "愿望"], medium: ["未来", "希望", "追求"]}
    };

    const wordData = semanticKB[targetWord];
    if (wordData) {
        if (wordData.high?.includes(guessWord)) return 75;
        if (wordData.medium?.includes(guessWord)) return 50;
    }
    
    // 优化备用算法：根据大类智能判断，不再返回固定值
    const categoryMap = {
        "自然类": {
            high: ["天", "地", "山", "水", "风", "雨", "云", "雪", "日", "月", "星", "海", "河", "湖", "森"],
            medium: ["大", "小", "白", "黑", "红", "绿", "蓝", "黄", "金", "银"]
        },
        "动物类": {
            high: ["猫", "狗", "鸟", "鱼", "虫", "兽", "虎", "狮", "熊", "象", "鹿", "马", "牛", "羊", "鸡"],
            medium: ["小", "大", "白", "黑", "花", "野", "动", "宠"]
        },
        "物品类": {
            high: ["机", "电", "书", "笔", "纸", "桌", "椅", "床", "门", "窗", "车", "房", "杯", "瓶", "包"],
            medium: ["小", "大", "电", "子", "用", "品", "家"]
        },
        "人物类": {
            high: ["人", "师", "生", "医", "工", "农", "兵", "警", "员", "家", "者", "手", "王", "星", "导"],
            medium: ["老", "小", "男", "女", "职", "业", "工"]
        },
        "抽象类": {
            high: ["心", "情", "感", "思", "想", "梦", "爱", "友", "信", "望", "勇", "智", "自", "由", "幸"],
            medium: ["好", "美", "快", "乐", "悲", "伤", "孤", "独", "时", "间"]
        }
    };

    // 根据大类智能评分
    const catData = categoryMap[category];
    if (catData) {
        // 检查是否有高相关字
        for (let c of guessWord) {
            if (catData.high.includes(c)) return Math.floor(Math.random() * 20) + 50; // 50-69
        }
        // 检查是否有中相关字
        for (let c of guessWord) {
            if (catData.medium.includes(c)) return Math.floor(Math.random() * 15) + 30; // 30-44
        }
    }

    // 同字匹配加分
    let sameChar = 0;
    let targetChars = new Set(targetWord.split(''));
    for (let c of guessWord) {
        if (targetChars.has(c)) sameChar++;
    }
    if (sameChar > 0) return Math.min(80, sameChar * 20 + Math.floor(Math.random() * 10));

    // 完全不相关：随机返回 5-25，避免全部一样
    return Math.floor(Math.random() * 21) + 5;
}

// ====================== API接口 ======================

// 注册接口
app.post('/api/register', (req, res) => {
    const {username, password, nickname} = req.body;
    if (!username || !password || !nickname) {
        return res.json({success: false, msg: '请填写完整信息'});
    }
    if (username.length < 3) return res.json({success: false, msg: '用户名至少3位'});
    if (password.length < 6) return res.json({success: false, msg: '密码至少6位'});

    const currentSeason = getCurrentSeason();
    
    // 检查用户名是否已存在
    db.get('SELECT id FROM users WHERE username = ?', [username], (err, user) => {
        if (user) return res.json({success: false, msg: '用户名已存在'});
        
        // 注册新用户
        db.run('INSERT INTO users (username, password, nickname, current_season) VALUES (?, ?, ?, ?)', 
            [username, password, nickname, currentSeason], function(err) {
            if (err) return res.json({success: false, msg: '注册失败'});
            res.json({
                success: true,
                msg: '注册成功！',
                user: {
                    id: this.lastID,
                    nickname,
                    seasonScore: 0,
                    totalScore: 0,
                    level: "青铜Ⅲ",
                    currentSeason,
                    isAdmin: 0
                }
            });
        });
    });
});

// 登录接口
app.post('/api/login', (req, res) => {
    const {username, password} = req.body;
    if (!username || !password) {
        return res.json({success: false, msg: '请输入用户名和密码'});
    }

    const currentSeason = getCurrentSeason();
    
    db.get('SELECT * FROM users WHERE username = ? AND password = ?', [username, password], (err, user) => {
        if (err) return res.json({success: false, msg: '数据库错误'});
        if (!user) return res.json({success: false, msg: '用户名或密码错误'});

        // 检查赛季是否更新
        if (user.current_season !== currentSeason) {
            db.run('UPDATE users SET season_score = 0, current_season = ? WHERE id = ?', [currentSeason, user.id], () => {
                res.json({
                    success: true,
                    user: {
                        id: user.id,
                        nickname: user.nickname,
                        seasonScore: 0,
                        totalScore: user.total_score,
                        level: getLevel(0),
                        currentSeason,
                        isAdmin: user.is_admin || 0
                    }
                });
            });
        } else {
            res.json({
                success: true,
                user: {
                    id: user.id,
                    nickname: user.nickname,
                    seasonScore: user.season_score,
                    totalScore: user.total_score,
                    level: getLevel(user.season_score),
                    currentSeason,
                    isAdmin: user.is_admin || 0
                }
            });
        }
    });
});

// 计算相关度接口（核心AI功能）
app.post('/api/calc-similarity', async (req, res) => {
    const {guessWord, targetWord, category} = req.body;
    
    // 调用AI语义判断
    const similarity = await aiCalcSimilarity(guessWord, targetWord, category);
    
    res.json({
        success: true,
        similarity: similarity
    });
});

// 猜对后更新分数
app.post('/api/guess-success', (req, res) => {
    const {userId, targetWord, usedTime} = req.body;
    if (!userId) return res.json({success: false, msg: '用户未登录'});

    const currentSeason = getCurrentSeason();
    
    db.serialize(() => {
        // 更新用户分数
        db.run('UPDATE users SET season_score = season_score + 1, total_score = total_score + 1 WHERE id = ?', [userId], (err) => {
            if (err) return res.json({success: false, msg: '更新失败'});
            
            // 返回最新用户信息
            db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
                res.json({
                    success: true,
                    user: {
                        id: user.id,
                        nickname: user.nickname,
                        seasonScore: user.season_score,
                        totalScore: user.total_score,
                        level: getLevel(user.season_score),
                        currentSeason,
                        isAdmin: user.is_admin || 0
                    }
                });
            });
        });
    });
});

// 获取排行榜
app.get('/api/rank', (req, res) => {
    const currentSeason = getCurrentSeason();
    db.all(`
        SELECT nickname, season_score as score 
        FROM users 
        WHERE current_season = ? AND season_score > 0
        ORDER BY season_score DESC 
        LIMIT 20
    `, [currentSeason], (err, list) => {
        if (err) return res.json({success: false, msg: '获取排行榜失败'});
        res.json({
            success: true,
            currentSeason,
            rankList: list.map((item, index) => ({
                rank: index + 1,
                nickname: item.nickname,
                score: item.score,
                level: getLevel(item.score)
            }))
        });
    });
});

// 启动服务
app.listen(PORT, () => {
    console.log(`✅ 猜词游戏后端服务启动成功！`);
    console.log(`📌 访问地址：http://localhost:${PORT}`);
    console.log(`🤖 已启用AI智能语义相关度判断`);
    console.log(`📅 当前赛季：${getCurrentSeason()}`);
});
