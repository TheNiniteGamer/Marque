sub init()
    m.list = m.top.findNode("list")
    m.menu = m.top.findNode("menu")
    m.prefs = { autoplayNext: true, autoSkipIntro: false, nightMode: false, skipFade: 10 }
    m.rows = []
    m.list.observeField("itemSelected", "onPicked")
    m.menu.observeField("chosen", "onFade")
    m.menu.observeField("closed", "onMenuClosed")
    m.top.observeField("focusedChild", "onFocusChange")
    m.top.findNode("note").text = "Passwords, PINs, libraries and everything else are in Marquee on a phone or computer: " + mqStr(m.global.server)
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.list.setFocus(true)
end sub

sub onParams()
    paint()
    mqApi("/api/auth/me", "onMe")
end sub

sub onMe(event as Object)
    r = event.getData()
    if r.status = 200 and r.data <> invalid and r.data.user <> invalid and r.data.user.prefs <> invalid then
        p = r.data.user.prefs
        m.prefs.autoplayNext = mqIsTrue(p.autoplayNext)
        m.prefs.autoSkipIntro = mqIsTrue(p.autoSkipIntro)
        m.prefs.nightMode = mqIsTrue(p.nightMode)
        m.prefs.skipFade = mqNum(p.skipFade)
        paint()
    end if
end sub

function onOff(v as Boolean) as String
    if v then return "On"
    return "Off"
end function

function fadeLabel(s as Float) as String
    if s <= 0 then return "Never"
    return Int(s).ToStr() + " s"
end function

' Each row: { label, act }.
sub paint()
    m.rows = [
        { label: "Who's watching: " + mqStr(m.global.username) + "  ·  Switch profile", act: "profile" },
        { label: "Play the next episode automatically:  " + onOff(m.prefs.autoplayNext), act: "autoplayNext" },
        { label: "Skip intros automatically:  " + onOff(m.prefs.autoSkipIntro), act: "autoSkipIntro" },
        { label: "Night mode (clearer dialogue, quieter loud scenes):  " + onOff(m.prefs.nightMode), act: "nightMode" },
        { label: "Turn on subtitles by default:  " + onOff(mqRead("subsOn:" + mqStr(m.global.username)) = "1"), act: "subsOn" },
        { label: "Skip Intro / Skip Credits buttons fade after:  " + fadeLabel(m.prefs.skipFade), act: "fade" },
        { label: "Marquee for Roku " + CreateObject("roAppInfo").GetVersion() + "  ·  Switch server", act: "server" },
        { label: "Sign out", act: "signout" },
    ]
    root = CreateObject("roSGNode", "ContentNode")
    for each row in m.rows
        n = root.createChild("ContentNode")
        n.title = row.label
    end for
    keep = m.list.itemFocused
    m.list.content = root
    if keep > 0 then m.list.jumpToItem = keep
end sub

sub onPicked()
    a = m.rows[m.list.itemSelected].act
    if a = "profile" then
        m.top.navigate = { screen: "ProfilesScreen", params: {} }
    else if a = "autoplayNext" or a = "autoSkipIntro" or a = "nightMode" then
        m.prefs[a] = not m.prefs[a]
        body = {}
        body[a] = m.prefs[a]
        mqApi("/api/auth/prefs", "onSaved", "PUT", body)
        paint()
    else if a = "subsOn" then
        key = "subsOn:" + mqStr(m.global.username)
        if mqRead(key) = "1" then mqWrite(key, "0") else mqWrite(key, "1")
        paint()
    else if a = "fade" then
        m.menu.title = "Skip Intro / Skip Credits buttons fade after"
        m.menu.options = ["5 seconds", "10 seconds", "15 seconds", "30 seconds", "Never (they stay up)"]
        m.menu.current = [5, 10, 15, 30, 0].Count() - 1
        i = 0
        for each v in [5, 10, 15, 30, 0]
            if v = m.prefs.skipFade then m.menu.current = i
            i = i + 1
        end for
        m.menu.open = true
    else if a = "server" then
        m.top.navigate = { screen: "SetupScreen", params: {}, reset: true }
    else if a = "signout" then
        mqApi("/api/auth/logout", "onLoggedOut", "POST")
    end if
end sub

sub onFade()
    m.prefs.skipFade = [5, 10, 15, 30, 0][m.menu.chosen]
    mqApi("/api/auth/prefs", "onSaved", "PUT", { skipFade: m.prefs.skipFade })
    paint()
    m.list.setFocus(true)
end sub

sub onMenuClosed()
    m.list.setFocus(true)
end sub

sub onSaved()
end sub

sub onLoggedOut()
    mqDelete("token")
    m.global.token = ""
    m.top.navigate = { screen: "PairScreen", reset: true }
end sub
