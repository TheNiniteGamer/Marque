sub init()
    m.backdrop = m.top.findNode("backdrop")
    m.eyebrow = m.top.findNode("eyebrow")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.progress = m.top.findNode("progress")
    m.overview = m.top.findNode("overview")
    m.side = m.top.findNode("side")
    m.buttons = m.top.findNode("buttons")
    m.rows = m.top.findNode("rows")
    m.menu = m.top.findNode("menu")
    m.actions = []
    m.rowItems = []
    m.version = ""
    m.focus = m.buttons
    m.top.observeField("focusedChild", "onFocusChange")
    m.buttons.observeField("selected", "onButton")
    m.rows.observeField("rowItemSelected", "onRowSelected")
    m.menu.observeField("chosen", "onMenuChosen")
    m.menu.observeField("closed", "onMenuClosed")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.focus.setFocus(true)
end sub

sub onParams()
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    p = m.top.params
    if p.kind = "show" then mqApi("/api/shows/" + p.id + "?episodes=none", "onLoaded") else mqApi("/api/items/" + p.id, "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.title.text = "Can't load this title"
        m.overview.text = r.error
        return
    end if
    x = r.data
    m.item = x
    kind = mqStr(x.type)
    art = "backdrop"
    if kind = "episode" or kind = "extra" then art = "thumb"
    m.backdrop.uri = mqArt(art, x)
    m.title.text = mqStr(x.title)
    ' Above the name: the show and episode, what kind of extra, or the franchise it's part of.
    m.eyebrow.text = ""
    if kind = "episode" then
        m.eyebrow.text = UCase(mqStr(x.showTitle) + "  ·  " + mqEpLabel(x))
    else if kind = "extra" then
        m.eyebrow.text = UCase(mqStr(x.extraLabel))
        if x.parent <> invalid then m.eyebrow.text = m.eyebrow.text + "  ·  " + UCase(mqStr(x.parent.title))
    else if x.franchise <> invalid then
        m.eyebrow.text = UCase(mqStr(x.franchise.name))
    end if
    parts = []
    if x.year <> invalid and kind <> "episode" then parts.Push(mqStr(x.year))
    if kind = "show" then
        parts.Push(plural(mqNum(x.seasonCount), "season"))
        parts.Push(plural(mqNum(x.episodeCount), "episode"))
        if mqNum(x.unwatchedCount) > 0 and mqNum(x.unwatchedCount) < mqNum(x.episodeCount) then parts.Push(mqStr(x.unwatchedCount) + " unwatched")
    else
        parts.Push(mqDuration(x.duration))
    end if
    if x.contentRating <> invalid then parts.Push(mqStr(x.contentRating))
    if x.rating <> invalid then parts.Push("★ " + mqStr(x.rating))
    if kind <> "show" and x.progress <> invalid and mqIsTrue(x.progress.watched) then parts.Push("Watched")
    m.meta.text = parts.Join("   ")
    m.overview.text = mqStr(x.overview)
    if mqStr(x.tagline) <> "" and m.overview.text = "" then m.overview.text = mqStr(x.tagline)

    side = []
    if x.genres <> invalid and x.genres.Count() > 0 then side.Push("Genres: " + x.genres.Join(", "))
    if kind = "episode" and x.cast <> invalid and x.cast.Count() > 0 then
        names = []
        for each c in x.cast
            if names.Count() < 5 then names.Push(c.name)
        end for
        side.Push("Cast: " + names.Join(", "))
    end if
    m.side.text = side.Join("     ")

    buildButtons(x)
    buildRows(x)
    ' (Empty lines take no room.)
    for each l in [m.eyebrow, m.progress, m.side, m.overview]
        l.visible = l.text <> ""
    end for
    ' (Not while a menu is open: it keeps the highlight.)
    if m.top.isInFocusChain() and not m.menu.visible then m.focus.setFocus(true)
end sub

function plural(n as Float, word as String) as String
    if n = 1 then return "1 " + word
    return Int(n).ToStr() + " " + word + "s"
end function

' The buttons: play first, then what can be done with it (a list of { label, act }).
sub buildButtons(x as Object)
    kind = mqStr(x.type)
    m.actions = []
    m.progress.text = ""
    if kind = "show" then
        up = x.upNext
        if up <> invalid then
            label = "▶  Play " + mqEpLabel(up)
            if mqIsTrue(up.again) then label = "▶  Watch again from the start"
            if up.progress <> invalid and mqNum(up.progress.position) > 0 and not mqIsTrue(up.progress.watched) then
                label = "▶  Resume " + mqEpLabel(up)
                m.progress.text = mqEpLabel(up) + " · " + mqStr(up.title) + " — " + mqTimeLeft(up)
            end if
            m.actions.Push({ label: label, act: "play", id: up.id, start: -1 })
        end if
        m.actions.Push({ label: "Episodes", act: "episodes" })
    else if x.media <> invalid then
        p = x.progress
        if p <> invalid and not mqIsTrue(p.watched) and mqNum(p.position) > 15 then
            m.actions.Push({ label: "▶  Resume", act: "play", id: x.id, start: -1 })
            m.actions.Push({ label: "From the start", act: "play", id: x.id, start: 0 })
            m.progress.text = mqTimeLeft(x)
        else
            m.actions.Push({ label: "▶  Play", act: "play", id: x.id, start: 0 })
        end if
        if x.versions <> invalid and x.versions.Count() > 1 then m.actions.Push({ label: versionLabel(x), act: "version" })
    end if
    if kind = "show" or kind = "movie" then
        if mqIsTrue(x.inWatchlist) then m.actions.Push({ label: "Remove from My List", act: "list" }) else m.actions.Push({ label: "+  My List", act: "list" })
        thumb = mqNum(x.thumb)
        rate = "Rate"
        if thumb = 1 then rate = "You liked this"
        if thumb = -1 then rate = "Not for you"
        m.actions.Push({ label: rate, act: "rate" })
    end if
    if kind = "episode" then
        if x.prev <> invalid then m.actions.Push({ label: "Previous: " + mqEpLabel(x.prev), act: "open", id: x.prev.id })
        if x.next <> invalid then m.actions.Push({ label: "Next: " + mqEpLabel(x.next), act: "open", id: x.next.id })
    end if
    if kind <> "extra" then
        m.watched = false
        if kind = "show" then
            m.watched = mqNum(x.episodeCount) > 0 and mqNum(x.unwatchedCount) = 0
        else if x.progress <> invalid then
            m.watched = mqIsTrue(x.progress.watched)
        end if
        if m.watched then m.actions.Push({ label: "Mark unwatched", act: "watched" }) else m.actions.Push({ label: "Mark watched", act: "watched" })
    end if
    if kind = "show" then m.actions.Push({ label: "More seasons", act: "seasons" })
    if kind = "episode" then m.actions.Push({ label: "All episodes", act: "show" })
    labels = []
    for each a in m.actions
        labels.Push(a.label)
    end for
    keep = m.buttons.index
    m.buttons.buttons = labels
    if keep < labels.Count() then m.buttons.index = keep
end sub

function versionLabel(x as Object) as String
    if m.version = "" then return "Version: Best for this TV"
    for each v in x.versions
        if mqStr(v.id) = m.version then return "Version: " + mqStr(v.label)
    end for
    return "Version"
end function

' Rows under the buttons, as on the web: trailers & extras, the cast, the franchise, more like this.
sub buildRows(x as Object)
    root = CreateObject("roSGNode", "ContentNode")
    m.rowItems = []
    sizes = []
    if x.extras <> invalid and x.extras.Count() > 0 then addRow(root, sizes, "Trailers & extras", x.extras, invalid)
    if mqStr(x.type) <> "episode" and x.cast <> invalid and x.cast.Count() > 0 then
        cast = []
        for each c in x.cast
            if cast.Count() < 12 then cast.Push(c)
        end for
        addRow(root, sizes, "Cast", cast, "person")
    end if
    f = x.franchise
    if f <> invalid and f.items <> invalid and f.items.Count() > 0 then addRow(root, sizes, "More from " + mqStr(f.name), f.items, invalid)
    if x.similar <> invalid and x.similar.Count() > 0 then addRow(root, sizes, "More like this", x.similar, invalid)
    m.rows.visible = root.getChildCount() > 0
    if root.getChildCount() = 0 then
        m.rows.content = invalid
        if m.focus.isSameNode(m.rows) then m.focus = m.buttons
        return
    end if
    m.rows.rowItemSize = sizes
    keep = m.rows.rowItemFocused
    m.rows.content = root
    if keep <> invalid and keep.Count() = 2 and keep[0] < root.getChildCount() then m.rows.jumpToRowItem = keep
end sub

sub addRow(root as Object, sizes as Object, title as String, list as Object, kind as Dynamic)
    row = root.createChild("ContentNode")
    row.title = title
    items = []
    for each it in list
        if kind = "person" then
            row.appendChild(mqPersonCard(it))
            items.Push({ type: "person", name: mqStr(it.name) })
        else
            row.appendChild(mqCard(it))
            items.Push(it)
        end if
    end for
    m.rowItems.Push(items)
    if kind = "person" then sizes.Push([216, 216]) else sizes.Push([384, 216])
end sub

sub onRowSelected()
    at = m.rows.rowItemSelected
    if at = invalid or at.Count() < 2 or at[0] >= m.rowItems.Count() then return
    it = m.rowItems[at[0]][at[1]]
    if it = invalid then return
    nav = mqOpen(it)
    if nav <> invalid then m.top.navigate = nav
end sub

sub onButton()
    a = m.actions[m.buttons.selected]
    if a = invalid then return
    x = m.item
    if a.act = "play" then
        params = { id: a.id, start: a.start }
        if m.version <> "" then params.version = m.version
        m.top.navigate = { screen: "PlayerScreen", params: params }
    else if a.act = "episodes" then
        season = invalid
        if x.upNext <> invalid then season = x.upNext.season
        m.top.navigate = { screen: "EpisodesScreen", params: { id: x.id, title: x.title, season: season } }
    else if a.act = "show" then
        m.top.navigate = { screen: "DetailsScreen", params: { id: x.showId, kind: "show" } }
    else if a.act = "open" then
        m.top.navigate = { screen: "DetailsScreen", params: { id: a.id, kind: "episode" }, replace: true }
    else if a.act = "list" then
        method = "PUT"
        if mqIsTrue(x.inWatchlist) then method = "DELETE"
        mqApi("/api/watchlist/" + x.id, "onChanged", method)
    else if a.act = "watched" then
        if x.type = "show" then
            mqApi("/api/shows/" + x.id + "/watched", "onChanged", "POST", { watched: not m.watched })
        else
            mqApi("/api/items/" + x.id + "/watched", "onChanged", "POST", { watched: not m.watched })
        end if
    else if a.act = "seasons" then
        m.top.navigate = { screen: "SeasonsScreen", params: { id: x.id, title: x.title } }
    else if a.act = "rate" then
        openMenu("rate", "Rate " + mqStr(x.title), ["I like this", "Not for me", "No rating"], ratingIndex(mqNum(x.thumb)))
    else if a.act = "version" then
        options = ["Best for this TV"]
        current = 0
        i = 1
        for each v in x.versions
            options.Push(mqStr(v.label))
            if mqStr(v.id) = m.version then current = i
            i = i + 1
        end for
        openMenu("version", "Which version to play", options, current)
    end if
end sub

function ratingIndex(thumb as Float) as Integer
    if thumb = 1 then return 0
    if thumb = -1 then return 1
    return 2
end function

sub openMenu(kind as String, title as String, options as Object, current as Integer)
    m.menuKind = kind
    m.menu.title = title
    m.menu.options = options
    m.menu.current = current
    m.menu.open = true
end sub

sub onMenuChosen()
    i = m.menu.chosen
    x = m.item
    if m.menuKind = "rate" then
        values = [1, -1, 0]
        mqApi("/api/thumbs/" + x.id, "onChanged", "PUT", { value: values[i] })
    else if m.menuKind = "version" then
        if i = 0 then m.version = "" else m.version = mqStr(x.versions[i - 1].id)
        buildButtons(x)
    end if
    m.buttons.setFocus(true)
end sub

sub onMenuClosed()
    m.buttons.setFocus(true)
end sub

sub onChanged()
    load()
end sub

function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "down" and m.buttons.hasFocus() and m.rows.visible then
        m.focus = m.rows
        m.rows.setFocus(true)
        return true
    end if
    if key = "up" and m.rows.hasFocus() then
        m.focus = m.buttons
        m.buttons.setFocus(true)
        return true
    end if
    return false
end function
