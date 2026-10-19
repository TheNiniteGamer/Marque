sub init()
    m.backdrop = m.top.findNode("backdrop")
    m.kind = m.top.findNode("kind")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.overview = m.top.findNode("overview")
    m.heroButtons = m.top.findNode("heroButtons")
    m.rows = m.top.findNode("rows")
    m.menu = m.top.findNode("menu")
    m.menuList = m.top.findNode("menuList")
    m.status = m.top.findNode("status")
    m.hero = invalid
    m.libraries = []
    m.focus = m.rows
    m.top.observeField("focusedChild", "onFocusChange")
    m.heroButtons.observeField("buttonSelected", "onHeroButton")
    m.rows.observeField("rowItemFocused", "onRowFocused")
    m.rows.observeField("rowItemSelected", "onRowSelected")
    m.menuList.observeField("itemSelected", "onMenuSelected")
    m.status.text = "Loading…"
    load()
    mqApi("/api/libraries", "onLibraries")
end sub

sub onFocusChange()
    if m.top.hasFocus() and m.focus <> invalid then m.focus.setFocus(true)
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    mqApi("/api/home", "onHome")
end sub

sub onHome(event as Object)
    r = event.getData()
    if r.status = 401 then
        signedOut()
        return
    end if
    if r.status <> 200 or r.data = invalid then
        m.status.text = "Can't load the home page: " + r.error
        return
    end if
    m.status.text = ""
    m.hero = r.data.hero
    root = CreateObject("roSGNode", "ContentNode")
    for each hub in r.data.hubs
        row = root.createChild("ContentNode")
        row.title = hub.title
        for each item in hub.items
            if item.type <> "collection" then row.appendChild(mqCard(item))
        end for
    end for
    keep = m.rows.rowItemFocused
    m.rows.content = root
    if m.hero <> invalid then
        labels = ["More info"]
        if m.hero.play <> invalid then labels = [mqStr(m.hero.play.label), "More info"]
        m.heroButtons.buttons = labels
        m.heroButtons.visible = true
    else
        m.heroButtons.visible = false
    end if
    if m.focus.isSameNode(m.heroButtons) and m.hero = invalid then m.focus = m.rows
    if keep <> invalid and keep.Count() = 2 and keep[0] < root.getChildCount() then m.rows.jumpToRowItem = keep
    if m.firstLoad = invalid then
        m.firstLoad = true
        if m.hero <> invalid then m.focus = m.heroButtons
        if m.top.isInFocusChain() then m.focus.setFocus(true)
    end if
    if m.focus.isSameNode(m.heroButtons) then showInfo(m.hero) else onRowFocused()
end sub

sub onLibraries(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then return
    m.libraries = r.data
    root = CreateObject("roSGNode", "ContentNode")
    for each label in ["Home", "Search", "My List"]
        n = root.createChild("ContentNode")
        n.title = label
    end for
    for each lib in m.libraries
        n = root.createChild("ContentNode")
        n.title = lib.name
    end for
    n = root.createChild("ContentNode")
    n.title = "Sign out"
    m.menuList.content = root
end sub

' The top of the screen: a title's artwork, name, details and summary.
sub showInfo(item as Dynamic)
    if item = invalid then return
    kind = mqStr(item.type)
    art = "backdrop"
    if kind = "episode" then art = "thumb"
    m.backdrop.uri = mqArt(art, item)
    if kind = "show" then
        m.kind.text = "S E R I E S"
    else if kind = "episode" then
        m.kind.text = UCase(mqEpLabel(item) + "  ·  " + mqStr(item.title))
    else
        m.kind.text = "F I L M"
    end if
    m.title.text = mqStr(item.title)
    if kind = "episode" then m.title.text = mqStr(item.showTitle)
    parts = []
    if item.year <> invalid then parts.Push(mqStr(item.year))
    if kind = "show" then parts.Push(mqStr(item.seasonCount) + " seasons") else parts.Push(mqDuration(item.duration))
    if item.rating <> invalid then parts.Push("★ " + mqStr(item.rating))
    left = mqTimeLeft(item)
    if left <> "" then parts.Push(left)
    m.meta.text = parts.Join("   ")
    m.overview.text = mqStr(item.overview)
end sub

sub onRowFocused()
    if not m.rows.hasFocus() then return
    at = m.rows.rowItemFocused
    c = contentAt(at)
    if c <> invalid then showInfo(c.data)
end sub

function contentAt(at as Dynamic) as Dynamic
    if at = invalid or at.Count() < 2 or m.rows.content = invalid then return invalid
    row = m.rows.content.getChild(at[0])
    if row = invalid then return invalid
    return row.getChild(at[1])
end function

sub onRowSelected()
    c = contentAt(m.rows.rowItemSelected)
    if c = invalid then return
    open(c.data)
end sub

' Episodes (Continue Watching) play straight away; movies and shows open their details.
sub open(item as Object)
    if item.type = "episode" then
        m.top.navigate = { screen: "PlayerScreen", params: { id: item.id, start: -1 } }
    else
        m.top.navigate = { screen: "DetailsScreen", params: { id: item.id, kind: item.type } }
    end if
end sub

sub onHeroButton()
    if m.hero = invalid then return
    i = m.heroButtons.buttonSelected
    if m.hero.play <> invalid and i = 0 then
        start = -1
        if m.hero.play.t <> invalid then start = 0
        m.top.navigate = { screen: "PlayerScreen", params: { id: m.hero.play.id, start: start } }
    else
        m.top.navigate = { screen: "DetailsScreen", params: { id: m.hero.id, kind: m.hero.type } }
    end if
end sub

sub openMenu()
    m.menu.visible = true
    m.menuList.setFocus(true)
end sub

sub closeMenu()
    m.menu.visible = false
    m.focus.setFocus(true)
end sub

sub onMenuSelected()
    i = m.menuList.itemSelected
    m.menu.visible = false
    m.focus.setFocus(true)
    libStart = 3
    if i = 0 then
        return
    else if i = 1 then
        m.top.navigate = { screen: "SearchScreen" }
    else if i = 2 then
        m.top.navigate = { screen: "GridScreen", params: { title: "My List", path: "/api/watchlist" } }
    else if i >= libStart and i < libStart + m.libraries.Count() then
        lib = m.libraries[i - libStart]
        m.top.navigate = { screen: "GridScreen", params: { title: lib.name, path: "/api/libraries/" + lib.id + "/items" } }
    else
        mqApi("/api/auth/logout", "onLoggedOut", "POST")
    end if
end sub

sub onLoggedOut()
    signedOut()
end sub

sub signedOut()
    mqDelete("token")
    m.global.token = ""
    m.top.navigate = { screen: "PairScreen", reset: true }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if m.menu.visible then
        if key = "right" or key = "back" then
            closeMenu()
            return true
        end if
        return false
    end if
    if key = "left" then
        openMenu()
        return true
    end if
    if key = "options" then
        m.top.navigate = { screen: "SearchScreen" }
        return true
    end if
    if key = "down" and m.heroButtons.hasFocus() then
        m.focus = m.rows
        m.rows.setFocus(true)
        onRowFocused()
        return true
    end if
    if key = "up" and m.rows.hasFocus() and m.hero <> invalid then
        m.focus = m.heroButtons
        m.heroButtons.setFocus(true)
        showInfo(m.hero)
        return true
    end if
    return false
end function
