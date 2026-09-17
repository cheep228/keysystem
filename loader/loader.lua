-- SrannyHub loader: окно ввода ключа -> проверка на сайте -> загрузка хаба с сервера
local SITE = "https://YOUR_DOMAIN" -- реальный адрес в loader.prod.lua (не в git)
local KEY_FILE = "SrannyHub/key.txt"

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local player = Players.LocalPlayer

local function getHwid()
	if type(gethwid) == "function" then
		local ok, id = pcall(gethwid)
		if ok and id then return tostring(id) end
	end
	return game:GetService("RbxAnalyticsService"):GetClientId()
end

local function urlEncode(s)
	return HttpService:UrlEncode(s)
end

local function httpGet(url)
	local ok, res = pcall(game.HttpGet, game, url)
	return ok and res or nil
end

local function checkKey(key)
	local body = httpGet(("%s/api/verify?key=%s&hwid=%s"):format(SITE, urlEncode(key), urlEncode(getHwid())))
	if not body then return false, "нет связи с сервером" end
	local ok, data = pcall(HttpService.JSONDecode, HttpService, body)
	if not ok then return false, "неверный ответ сервера" end
	local reasons = {
		invalid_or_expired = "ключ неверный или истёк",
		expired = "ключ истёк",
		revoked = "ключ заблокирован",
		hwid_mismatch = "ключ привязан к другому устройству",
	}
	if data.valid then return true end
	return false, reasons[data.reason] or tostring(data.reason)
end

local function loadHub(key)
	local code = httpGet(("%s/api/script?key=%s&hwid=%s"):format(SITE, urlEncode(key), urlEncode(getHwid())))
	assert(code, "не удалось скачать скрипт")
	local fn, err = loadstring(code)
	assert(fn, err)
	fn()
end

local function saveKey(key)
	if type(writefile) ~= "function" then return end
	if type(makefolder) == "function" then pcall(makefolder, "SrannyHub") end
	pcall(writefile, KEY_FILE, key)
end

local function savedKey()
	if type(readfile) ~= "function" then return nil end
	local ok, k = pcall(readfile, KEY_FILE)
	return ok and k and k ~= "" and k or nil
end

-- сохранённый ключ ещё валиден — сразу грузим
local cached = savedKey()
if cached and checkKey(cached) then
	return loadHub(cached)
end

-- ===== окно ввода ключа =====
local gui = Instance.new("ScreenGui")
gui.Name = "SrannyHubKey"
gui.ResetOnSpawn = false
local okParent = pcall(function() gui.Parent = (gethui and gethui()) or game:GetService("CoreGui") end)
if not okParent or not gui.Parent then gui.Parent = player:WaitForChild("PlayerGui") end

local frame = Instance.new("Frame")
frame.Size = UDim2.fromOffset(340, 190)
frame.Position = UDim2.new(0.5, -170, 0.5, -95)
frame.BackgroundColor3 = Color3.fromRGB(21, 21, 29)
frame.BorderSizePixel = 0
frame.Active = true
frame.Draggable = true
frame.Parent = gui
Instance.new("UICorner", frame).CornerRadius = UDim.new(0, 12)
local stroke = Instance.new("UIStroke", frame)
stroke.Color = Color3.fromRGB(38, 38, 51)

local function label(text, y, size, color, font)
	local l = Instance.new("TextLabel")
	l.BackgroundTransparency = 1
	l.Size = UDim2.new(1, -24, 0, size + 6)
	l.Position = UDim2.fromOffset(12, y)
	l.Text = text
	l.TextColor3 = color
	l.TextSize = size
	l.Font = font or Enum.Font.Gotham
	l.Parent = frame
	return l
end

label("SrannyHub", 12, 22, Color3.fromRGB(150, 110, 255), Enum.Font.GothamBold)
local status = label("Введи ключ", 42, 13, Color3.fromRGB(139, 139, 160))

local box = Instance.new("TextBox")
box.Size = UDim2.new(1, -24, 0, 36)
box.Position = UDim2.fromOffset(12, 70)
box.BackgroundColor3 = Color3.fromRGB(14, 14, 20)
box.TextColor3 = Color3.new(1, 1, 1)
box.PlaceholderText = "SRANNY-XXXX-XXXX-XXXX-XXXX"
box.Text = ""
box.ClearTextOnFocus = false
box.Font = Enum.Font.Code
box.TextSize = 14
box.Parent = frame
Instance.new("UICorner", box).CornerRadius = UDim.new(0, 8)

local function button(text, x, color)
	local b = Instance.new("TextButton")
	b.Size = UDim2.new(0.5, -18, 0, 38)
	b.Position = UDim2.new(x, x == 0 and 12 or 6, 0, 120)
	b.BackgroundColor3 = color
	b.TextColor3 = Color3.new(1, 1, 1)
	b.Font = Enum.Font.GothamBold
	b.TextSize = 14
	b.Text = text
	b.Parent = frame
	Instance.new("UICorner", b).CornerRadius = UDim.new(0, 8)
	return b
end

local getBtn = button("Получить ключ", 0, Color3.fromRGB(38, 38, 51))
local checkBtn = button("Проверить", 0.5, Color3.fromRGB(124, 92, 255))

getBtn.MouseButton1Click:Connect(function()
	if setclipboard then
		setclipboard(SITE)
		status.Text = "Ссылка скопирована — открой её в браузере"
	else
		status.Text = SITE
	end
end)

local busy = false
checkBtn.MouseButton1Click:Connect(function()
	if busy then return end
	busy = true
	local key = box.Text:gsub("%s", "")
	status.Text = "Проверяю..."
	local ok, reason = checkKey(key)
	if ok then
		status.Text = "Ключ принят!"
		status.TextColor3 = Color3.fromRGB(61, 220, 132)
		saveKey(key)
		task.wait(0.4)
		gui:Destroy()
		loadHub(key)
	else
		status.Text = "Ошибка: " .. reason
		status.TextColor3 = Color3.fromRGB(255, 92, 122)
	end
	busy = false
end)
