sub init()
    m.backdrop = m.top.findNode("backdrop")
    m.kind = m.top.findNode("kind")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.overview = m.top.findNode("overview")
    m.heroButtons = m.top.findNode("heroButtons")
    m.rows = m.top.findNode("rows")
    m.topBar = m.top.findNode("topBar")
    m.status = m.top.findNode("status")
    m.hero = invalid
    m.focus = m.rows
    m.top.observeField("focusedChild", "onFocusChange")
    m.heroIndex = 0
    m.heroCount = 0
    m.heroButtons.observeField("focusedChild", "paintHeroButtons")
    m.rows.observeField("rowItemFocused", "onRowFocused")
    m.rows.observeField("rowItemSelected", "onRowSelected")
    m.topBar.observeField("chosen", "onTopBar")
    m.topBar.observeField("leave", "onTopBarLeave")
    m.topBar.observeField("focusedChild", "paintHeroButtons")
    m.status.text = "Loading…"
    load()
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
        if m.hero.play <> invalid then labels = ["▶  " + mqStr(m.hero.play.label), "More info"]
        setHeroButtons(labels)
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
    if item.contentRating <> invalid then parts.Push(mqStr(item.contentRating))
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

sub setHeroButtons(labels as Object)
    m.heroCount = labels.Count()
    if m.heroIndex >= m.heroCount then m.heroIndex = 0
    for i = 0 to 1
        m.top.findNode("hb" + i.ToStr()).visible = i < m.heroCount
        if i < m.heroCount then
            text = m.top.findNode("hbText" + i.ToStr())
            text.text = labels[i]
            w = text.boundingRect().width
            if w < 40 then w = Len(labels[i]) * 22
            m.top.findNode("hbBg" + i.ToStr()).width = w + 80
        end if
    end for
    paintHeroButtons()
end sub

' The highlighted button is white, the other grey. While moving through the rows the top shows the
' highlighted title instead, so the banner's buttons are hidden until you go back up (they stay
' while you're in the top bar, as on the web).
sub paintHeroButtons()
    focused = m.heroButtons.hasFocus()
    if focused or m.topBar.isInFocusChain() then m.heroButtons.opacity = 1.0 else m.heroButtons.opacity = 0.0
    for i = 0 to m.heroCount - 1
        on = focused and i = m.heroIndex
        bg = m.top.findNode("hbBg" + i.ToStr())
        text = m.top.findNode("hbText" + i.ToStr())
        if on then
            bg.color = "0xFFFFFFFF"
            text.color = "0x000000FF"
        else
            bg.color = "0x6D6D6EB3"
            text.color = "0xFFFFFFFF"
        end if
    end for
end sub

sub onHeroButton(i as Integer)
    if m.hero = invalid then return
    if m.hero.play <> invalid and i = 0 then
        start = -1
        if m.hero.play.t <> invalid then start = 0
        m.top.navigate = { screen: "PlayerScreen", params: { id: m.hero.play.id, start: start } }
    else
        m.top.navigate = { screen: "DetailsScreen", params: { id: m.hero.id, kind: m.hero.type } }
    end if
end sub

' The top bar: up from the banner (or the first row) reaches it.
sub toTopBar()
    m.topBar.setFocus(true)
    if m.hero <> invalid then showInfo(m.hero)
end sub

sub onTopBarLeave()
    m.focus.setFocus(true)
    paintHeroButtons()
    if m.focus.isSameNode(m.rows) then onRowFocused()
end sub

sub onTopBar()
    c = m.topBar.chosen
    if c.key = "signedout" then
        signedOut()
        return
    end if
    m.focus.setFocus(true)
    paintHeroButtons()
    if c.key <> "home" then m.top.navigate = mqTopBarNav(c, true)
end sub

sub signedOut()
    mqDelete("token")
    m.global.token = ""
    m.top.navigate = { screen: "PairScreen", reset: true }
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if m.heroButtons.hasFocus() and key = "up" then
        toTopBar()
        return true
    end if
    if m.heroButtons.hasFocus() then
        if key = "left" and m.heroIndex > 0 then
            m.heroIndex = m.heroIndex - 1
            paintHeroButtons()
            return true
        else if key = "right" then
            if m.heroIndex < m.heroCount - 1 then
                m.heroIndex = m.heroIndex + 1
                paintHeroButtons()
            end if
            return true
        else if key = "OK" then
            onHeroButton(m.heroIndex)
            return true
        end if
    end if
    if key = "options" then
        m.top.navigate = { screen: "SearchScreen" }
        return true
    end if
    if key = "down" and m.heroButtons.hasFocus() then
        m.focus = m.rows
        m.rows.setFocus(true)
        paintHeroButtons()
        onRowFocused()
        return true
    end if
    if key = "up" and m.rows.hasFocus() and m.hero <> invalid then
        m.focus = m.heroButtons
        m.heroButtons.setFocus(true)
        paintHeroButtons()
        showInfo(m.hero)
        return true
    end if
    if key = "up" and m.rows.hasFocus() then
        toTopBar()
        return true
    end if
    return false
end function
