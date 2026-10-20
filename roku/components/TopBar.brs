sub init()
    m.links = m.top.findNode("links")
    m.searchPill = m.top.findNode("searchPill")
    m.searchIcon = m.top.findNode("searchIcon")
    m.bellPill = m.top.findNode("bellPill")
    m.bellIcon = m.top.findNode("bellIcon")
    m.avatarRing = m.top.findNode("avatarRing")
    m.account = m.top.findNode("account")
    m.accountList = m.top.findNode("accountList")
    m.items = []
    m.index = 0
    m.wasIn = false
    m.picked = false
    name = mqStr(m.global.username)
    if name = "" then name = "?"
    m.top.findNode("avatarText").text = UCase(Left(name, 1))
    m.top.findNode("avatarBg").color = mqAvatarColor(name)
    menu = CreateObject("roSGNode", "ContentNode")
    for each label in ["Switch profile", "My requests", "Settings", "Sign out"]
        n = menu.createChild("ContentNode")
        n.title = label
    end for
    m.accountList.content = menu
    m.accountList.observeField("itemSelected", "onAccount")
    m.top.observeField("focusedChild", "onFocus")
    build([])
    mqApi("/api/libraries", "onLibraries")
    mqApi("/api/notifications", "onNotifications")
end sub

sub onReload()
    mqApi("/api/notifications", "onNotifications")
end sub

' Notifications not read yet: a count on the bell.
sub onNotifications(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then return
    n = mqNum(r.data.unread)
    dot = m.top.findNode("bellDot")
    count = m.top.findNode("bellCount")
    dot.visible = n > 0
    count.visible = n > 0
    if n > 9 then count.text = "9+" else count.text = Int(n).ToStr()
end sub

sub onLibraries(event as Object)
    r = event.getData()
    if r.status = 200 and r.data <> invalid then build(r.data)
end sub

' Home, each library, Collections, My List (as words), then notifications, Search and your
' profile on the right.
sub build(libraries as Object)
    while m.links.getChildCount() > 0
        m.links.removeChildIndex(0)
    end while
    entries = [{ key: "home", title: "Home" }]
    for each lib in libraries
        entries.Push({ key: "lib", id: mqStr(lib.id), title: mqStr(lib.name) })
    end for
    if libraries.Count() > 0 then entries.Push({ key: "collections", title: "Collections" })
    entries.Push({ key: "list", title: "My List" })
    m.items = []
    x = 0
    for each e in entries
        ' (Libraries that don't fit are left out of the bar; Search finds everything.)
        if e.key = "lib" and x > 700 then goto skip
        g = m.links.createChild("Group")
        g.translation = [x, 0]
        pill = g.createChild("Poster")
        pill.uri = "pkg:/images/pill.9.png"
        pill.opacity = 0
        t = g.createChild("Label")
        t.font = "font:MediumBoldSystemFont"
        t.text = e.title
        t.height = 60
        t.vertAlign = "center"
        t.translation = [24, 0]
        w = t.boundingRect().width
        if w < 20 then w = Len(e.title) * 19
        pill.width = w + 48
        pill.height = 60
        e.pill = pill
        e.label = t
        m.items.Push(e)
        x = x + w + 48 + 8
        skip:
    end for
    m.items.Push({ key: "bell" })
    m.items.Push({ key: "search" })
    m.items.Push({ key: "avatar" })
    if m.index >= m.items.Count() then m.index = 0
    paint()
end sub

function keyOf(e as Object) as String
    if e.key = "lib" then return "lib:" + e.id
    return e.key
end function

sub onFocus()
    inBar = m.top.isInFocusChain()
    ' Coming up into the bar: start on the page you're on.
    if inBar and not m.wasIn then
        m.picked = false
        for i = 0 to m.items.Count() - 1
            if keyOf(m.items[i]) = m.top.current then m.index = i
        end for
    end if
    m.wasIn = inBar
    if not inBar then m.account.visible = false
    paint()
end sub

sub paint()
    inBar = m.top.isInFocusChain() and not m.account.visible
    for i = 0 to m.items.Count() - 1
        e = m.items[i]
        on = inBar and i = m.index
        if e.key = "bell" then
            if on then m.bellPill.opacity = 1 else m.bellPill.opacity = 0
            if on then m.bellIcon.uri = "pkg:/images/ic_bell_dark.png" else m.bellIcon.uri = "pkg:/images/ic_bell.png"
        else if e.key = "search" then
            if on then m.searchPill.opacity = 1 else m.searchPill.opacity = 0
            if on then m.searchIcon.uri = "pkg:/images/ic_search_dark.png" else m.searchIcon.uri = "pkg:/images/ic_search.png"
        else if e.key = "avatar" then
            m.avatarRing.visible = on or m.account.visible
        else
            if on then e.pill.opacity = 1 else e.pill.opacity = 0
            if on then
                e.label.color = "0x000000FF"
            else if keyOf(e) = m.top.current then
                e.label.color = "0xFFFFFFFF"
            else
                e.label.color = "0xB3B3B3FF"
            end if
        end if
    end for
end sub

sub choose()
    e = m.items[m.index]
    if e = invalid then return
    if e.key = "avatar" then
        ' (Only on the screen you're looking at: a hidden screen's menu must never take the keys.)
        if not mqShown(m.top) then return
        m.account.visible = true
        m.accountList.jumpToItem = 0
        m.accountList.setFocus(true)
        paint()
    else if e.key = "search" or e.key = "bell" then
        m.top.chosen = { key: e.key }
    else if keyOf(e) = m.top.current then
        m.top.leave = true ' (already here)
    else
        m.top.chosen = { key: e.key, id: e.id, title: e.title }
    end if
end sub

sub closeAccount()
    m.account.visible = false
    m.top.setFocus(true)
    paint()
end sub

sub onAccount()
    ' (Only a choice made in the open menu counts: signing out needs Sign out to be picked.)
    if not m.account.visible or not m.accountList.hasFocus() then return
    i = m.accountList.itemSelected
    ' The OK that picked it may still come up to the bar: it mustn't open the menu again.
    m.picked = true
    if i < 3 then
        closeAccount()
        m.top.chosen = { key: ["profiles", "requests", "settings"][i] }
    else
        ' (The menu stays up until the server has signed this Roku out.)
        mqApi("/api/auth/logout", "onLoggedOut", "POST")
    end if
end sub

sub onLoggedOut()
    mqDelete("token")
    m.global.token = ""
    m.account.visible = false
    m.top.chosen = { key: "signedout" }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    ' A key still on its way up from the menu after it opened another screen (the OK that chose
    ' Settings, say) is used up: acting on it here would open this hidden bar's menu again.
    if not m.top.isInFocusChain() then return true
    if not press then return false
    if key = "OK" and m.picked then
        m.picked = false
        return true
    end if
    m.picked = false
    if m.account.visible then
        if key = "back" or key = "left" or (key = "up" and m.accountList.itemFocused = 0) then
            closeAccount()
            return true
        end if
        return key = "right" or key = "down" or key = "up" or key = "OK"
    end if
    if key = "left" then
        if m.index > 0 then m.index = m.index - 1
        paint()
        return true
    else if key = "right" then
        if m.index < m.items.Count() - 1 then m.index = m.index + 1
        paint()
        return true
    else if key = "OK" then
        choose()
        return true
    else if key = "down" or key = "back" then
        m.top.leave = true
        return true
    end if
    return key = "up"
end function
