sub init()
    m.picker = m.top.findNode("picker")
    m.grid = m.top.findNode("grid")
    m.hint = m.top.findNode("hint")
    m.pad = m.top.findNode("pad")
    m.padTitle = m.top.findNode("padTitle")
    m.dots = m.top.findNode("dots")
    m.keys = m.top.findNode("keys")
    m.padError = m.top.findNode("padError")
    m.status = m.top.findNode("status")
    m.profiles = []
    m.pin = ""
    m.target = invalid
    m.busy = false
    keys = CreateObject("roSGNode", "ContentNode")
    for each k in ["1", "2", "3", "4", "5", "6", "7", "8", "9", "Del", "0", "OK"]
        n = keys.createChild("ContentNode")
        n.title = k
    end for
    m.keys.content = keys
    m.top.observeField("focusedChild", "onFocusChange")
    m.grid.observeField("itemSelected", "onPicked")
    m.keys.observeField("itemSelected", "onKey")
end sub

sub onFocusChange()
    if not m.top.hasFocus() then return
    if m.pad.visible then m.keys.setFocus(true) else m.grid.setFocus(true)
end sub

sub onParams()
    m.status.text = ""
    mqApi("/api/profiles", "onProfiles")
end sub

function atStart() as Boolean
    return mqIsTrue(m.top.params.atStart)
end function

sub goHome()
    m.top.navigate = { screen: "HomeScreen", reset: true }
end sub

sub onProfiles(event as Object)
    r = event.getData()
    if r.status = 401 then
        mqDelete("token")
        m.global.token = ""
        m.top.navigate = { screen: "PairScreen", reset: true }
        return
    end if
    if r.status <> 200 or r.data = invalid then
        if atStart() then
            goHome()
        else
            m.status.text = "Can't load the profiles: " + r.error
        end if
        return
    end if
    current = mqStr(r.data.current)
    list = []
    found = false
    for each p in r.data.profiles
        if mqStr(p.id) = current then found = true
        list.Push(p)
    end for
    ' You're always on your own picker, even without a PIN.
    if not found then list.Unshift({ id: current, username: mqStr(r.data.currentName), needsPin: false, kids: false })
    m.current = current
    if atStart() and list.Count() < 2 then
        goHome()
        return
    end if
    m.profiles = list
    root = CreateObject("roSGNode", "ContentNode")
    focusAt = 0
    for i = 0 to list.Count() - 1
        p = list[i]
        c = root.createChild("ContentNode")
        c.addFields({ color: mqAvatarColor(mqStr(p.username)), needsPin: mqIsTrue(p.needsPin) and mqStr(p.id) <> current, kids: mqIsTrue(p.kids) })
        c.title = mqStr(p.username)
        if mqStr(p.id) = current then focusAt = i
    end for
    ' Centred: as many columns as profiles (up to 6 a row).
    cols = list.Count()
    if cols > 6 then cols = 6
    rows = Int((list.Count() + cols - 1) / cols)
    m.grid.numColumns = cols
    m.grid.numRows = rows
    m.grid.translation = [(1920 - (cols * 240 + (cols - 1) * 64)) / 2, 420 - (rows - 1) * 150]
    m.grid.content = root
    m.grid.jumpToItem = focusAt
    if list.Count() < 2 then
        m.hint.text = "Nobody else is here yet. Set a PIN on your Account page (on a phone or computer) to appear here."
    else
        m.hint.text = ""
    end if
    m.picker.visible = true
    if m.top.isInFocusChain() then m.grid.setFocus(true)
end sub

sub onPicked()
    if m.busy then return
    p = m.profiles[m.grid.itemSelected]
    if p = invalid then return
    if mqStr(p.id) = m.current then
        if atStart() then goHome() else m.top.navigate = { back: true }
        return
    end if
    m.target = p
    if mqIsTrue(p.needsPin) then
        showPad()
    else
        switchTo("")
    end if
end sub

sub showPad()
    m.pin = ""
    m.padTitle.text = "PIN for " + mqStr(m.target.username)
    m.padError.text = ""
    paintDots()
    m.picker.visible = false
    m.pad.visible = true
    m.keys.jumpToItem = 0
    m.keys.setFocus(true)
end sub

sub hidePad()
    m.pad.visible = false
    m.picker.visible = true
    m.grid.setFocus(true)
end sub

sub paintDots()
    if m.pin = "" then
        m.dots.text = "_ _ _ _"
        return
    end if
    d = []
    for i = 1 to Len(m.pin)
        d.Push("●")
    end for
    m.dots.text = d.Join(" ")
end sub

sub onKey()
    if m.busy then return
    k = m.keys.content.getChild(m.keys.itemSelected).title
    if k = "Del" then
        if Len(m.pin) > 0 then m.pin = Left(m.pin, Len(m.pin) - 1)
    else if k = "OK" then
        if Len(m.pin) >= 4 then switchTo(m.pin) else m.padError.text = "A PIN has 4 to 8 numbers"
    else if Len(m.pin) < 8 then
        m.pin = m.pin + k
        m.padError.text = ""
    end if
    paintDots()
end sub

sub switchTo(pin as String)
    m.busy = true
    m.status.text = ""
    mqApi("/api/auth/switch", "onSwitched", "POST", { userId: m.target.id, pin: pin })
end sub

sub onSwitched(event as Object)
    m.busy = false
    r = event.getData()
    if r.status = 200 and r.data <> invalid then
        if r.data.token <> invalid then
            mqWrite("token", r.data.token)
            m.global.token = r.data.token
        end if
        if r.data.user <> invalid then
            mqWrite("username", mqStr(r.data.user.username))
            m.global.username = mqStr(r.data.user.username)
        end if
        goHome()
        return
    end if
    if m.pad.visible then
        m.padError.text = r.error
        m.pin = ""
        paintDots()
    else
        m.status.text = r.error
    end if
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "back" and m.pad.visible then
        hidePad()
        return true
    end if
    return false
end function
