sub init()
    m.title = m.top.findNode("title")
    m.count = m.top.findNode("count")
    m.grid = m.top.findNode("grid")
    m.filters = m.top.findNode("filters")
    m.menu = m.top.findNode("menu")
    m.topBar = m.top.findNode("topBar")
    m.topBar.observeField("chosen", "onTopBar")
    m.topBar.observeField("leave", "onTopBarLeave")
    m.all = []
    m.items = []
    m.genres = []
    m.top.observeField("focusedChild", "onFocusChange")
    m.grid.observeField("itemSelected", "onSelected")
    m.filters.observeField("selected", "onFilter")
    m.menu.observeField("chosen", "onMenuChosen")
    m.menu.observeField("closed", "onMenuClosed")
end sub

sub onFocusChange()
    if m.top.hasFocus() then m.grid.setFocus(true)
end sub

sub onTopBarLeave()
    m.grid.setFocus(true)
end sub

sub onTopBar()
    c = m.topBar.chosen
    if c.key = "signedout" then
        m.top.navigate = { screen: "PairScreen", reset: true }
        return
    end if
    m.grid.setFocus(true)
    m.top.navigate = mqTopBarNav(c, false)
end sub

sub onParams()
    p = m.top.params
    m.topBar.current = mqStr(p.current)
    m.title.text = mqStr(p.title)
    m.count.text = "Loading…"
    ' A library: sorting and filters (kept for each library on this Roku).
    m.isLibrary = Left(mqStr(p.path), 15) = "/api/libraries/"
    m.prefs = { sort: "title", unwatched: false, genre: "" }
    if m.isLibrary then
        saved = invalid
        text = mqRead("lib:" + mqStr(p.path))
        if text <> "" then saved = ParseJson(text)
        if saved <> invalid and type(saved) = "roAssociativeArray" then
            if saved.sort <> invalid then m.prefs.sort = mqStr(saved.sort)
            m.prefs.unwatched = mqIsTrue(saved.unwatched)
        end if
    end if
    m.filters.visible = m.isLibrary
    ' (A library's count goes at the end of its filters' row.)
    if m.isLibrary then
        m.count.translation = [1124, 218]
        m.count.horizAlign = "right"
        m.count.width = 700
    end if
    load()
end sub

sub onRefresh()
    if m.top.refresh then load()
end sub

sub load()
    mqApi(m.top.params.path, "onLoaded")
end sub

sub onLoaded(event as Object)
    r = event.getData()
    if r.status <> 200 or r.data = invalid then
        m.count.text = "Can't load this: " + r.error
        return
    end if
    d = r.data
    list = d
    m.about = ""
    if type(d) = "roAssociativeArray" then
        if d.items <> invalid then list = d.items else list = d.titles
        ' A collection: what it is, and how far through it you are (a franchise's saga).
        if d.memberIds <> invalid then
            parts = []
            if mqStr(d.about) <> "" then parts.Push(mqStr(d.about))
            if mqNum(d.watched) > 0 then parts.Push(mqStr(d.watched) + " of " + mqStr(d.count) + " watched")
            if d.next <> invalid then
                if mqIsTrue(d.next.started) then parts.Push("Continue with " + mqStr(d.next.title)) else parts.Push("Next: " + mqStr(d.next.title))
            end if
            m.about = parts.Join("  ·  ")
        end if
    end if
    if list = invalid then list = []
    m.all = []
    genres = {}
    for each item in list
        if item.type <> "collection" then
            m.all.Push(item)
            if item.genres <> invalid then
                for each g in item.genres
                    genres[g] = true
                end for
            end if
        end if
    end for
    m.genres = genres.Keys()
    m.genres.Sort()
    show()
end sub

' The titles with the sorting and filters applied.
sub show()
    keep = m.grid.itemFocused
    list = []
    for each item in m.all
        ok = true
        if m.prefs.unwatched and mqWatched(item) then ok = false
        if ok and m.prefs.genre <> "" then
            ok = false
            if item.genres <> invalid then
                for each g in item.genres
                    if g = m.prefs.genre then ok = true
                end for
            end if
        end if
        if ok then list.Push(item)
    end for
    if m.isLibrary then list = sorted(list, m.prefs.sort)
    m.items = list
    root = CreateObject("roSGNode", "ContentNode")
    for each item in list
        root.appendChild(mqCard(item))
    end for
    m.grid.content = root
    if keep > 0 and keep < m.items.Count() then m.grid.jumpToItem = keep
    n = m.items.Count()
    text = n.ToStr() + " titles"
    if n = 1 then text = "1 title"
    if n = 0 then
        text = "Nothing here yet."
        if m.all.Count() > 0 then text = "Nothing matches these filters."
    end if
    if m.about <> "" then text = m.about + "  ·  " + text
    m.count.text = text
    paintFilters()
end sub

' Title (without "The"/"A"), date added, year, rating or length, as on the web.
function sorted(list as Object, by as String) as Object
    for each item in list
        t = LCase(mqStr(item.sortTitle))
        if t = "" then t = LCase(mqStr(item.title))
        for each article in ["the ", "a ", "an "]
            if Left(t, Len(article)) = article then t = Mid(t, Len(article) + 1)
        end for
        ' (Times as they came, not as Float: those lose the milliseconds and the order.)
        added = item.lastAddedAt
        if not mqIsNumber(added) then added = item.addedAt
        if not mqIsNumber(added) then added = 0
        item.sortKey = t
        item.addedKey = added
        item.yearKey = mqNum(item.year)
        item.ratingKey = mqNum(item.rating)
        item.lengthKey = mqNum(item.duration)
    end for
    if by = "added" then
        list.SortBy("addedKey", "r")
    else if by = "year" then
        list.SortBy("yearKey", "r")
    else if by = "rating" then
        list.SortBy("ratingKey", "r")
    else if by = "duration" then
        list.SortBy("lengthKey", "r")
    else
        list.SortBy("sortKey", "i")
    end if
    return list
end function

function sortNames() as Object
    return { title: "Title", added: "Date added", year: "Year", rating: "Rating", duration: "Length" }
end function

function sortKeys() as Object
    return ["title", "added", "year", "rating", "duration"]
end function

sub paintFilters()
    if not m.isLibrary then return
    labels = ["Sort: " + sortNames()[m.prefs.sort]]
    if m.prefs.unwatched then labels.Push("Unwatched") else labels.Push("All titles")
    if m.genres.Count() > 0 then
        if m.prefs.genre = "" then labels.Push("All genres") else labels.Push(m.prefs.genre)
    end if
    keep = m.filters.index
    m.filters.buttons = labels
    m.filters.index = keep
end sub

sub onFilter()
    i = m.filters.selected
    if i = 0 then
        options = []
        current = 0
        n = 0
        for each k in sortKeys()
            options.Push(sortNames()[k])
            if k = m.prefs.sort then current = n
            n = n + 1
        end for
        openMenu("sort", "Sort by", options, current)
    else if i = 1 then
        m.prefs.unwatched = not m.prefs.unwatched
        savePrefs()
        show()
    else if i = 2 then
        options = ["All genres"]
        current = 0
        n = 1
        for each g in m.genres
            options.Push(g)
            if g = m.prefs.genre then current = n
            n = n + 1
        end for
        openMenu("genre", "Genre", options, current)
    end if
end sub

sub savePrefs()
    mqWrite("lib:" + mqStr(m.top.params.path), FormatJson({ sort: m.prefs.sort, unwatched: m.prefs.unwatched }))
end sub

sub openMenu(kind as String, title as String, options as Object, current as Integer)
    m.menuKind = kind
    m.menu.title = title
    m.menu.options = options
    m.menu.current = current
    m.menu.open = true
end sub

sub onMenuChosen()
    i = m.menu.chosen
    if m.menuKind = "sort" then
        m.prefs.sort = sortKeys()[i]
        savePrefs()
        m.filters.setFocus(true)
        show()
    else if m.menuKind = "genre" then
        if i = 0 then m.prefs.genre = "" else m.prefs.genre = m.genres[i - 1]
        m.filters.setFocus(true)
        show()
    else if m.menuKind = "card" then
        m.grid.setFocus(true)
        nav = mqCardAct(m.menuItem, m.menuActs[i].act, "onChanged")
        if nav <> invalid then m.top.navigate = nav
    end if
end sub

sub onMenuClosed()
    if m.menuKind = "card" then m.grid.setFocus(true) else m.filters.setFocus(true)
end sub

sub onChanged()
    load()
end sub

sub onSelected()
    item = m.items[m.grid.itemSelected]
    if item = invalid then return
    nav = mqOpen(item)
    if nav <> invalid then m.top.navigate = nav
end sub

' Up from the top row reaches the filters (a library), then the top bar. ✱ on a card: its options.
function onKeyEvent(key as String, press as Boolean) as Boolean
    if not press then return false
    if key = "up" and m.grid.hasFocus() then
        if m.isLibrary then m.filters.setFocus(true) else m.topBar.setFocus(true)
        return true
    end if
    if key = "up" and m.filters.hasFocus() then
        m.topBar.setFocus(true)
        return true
    end if
    if key = "down" and m.filters.hasFocus() then
        m.grid.setFocus(true)
        return true
    end if
    if key = "options" and m.grid.hasFocus() then
        item = m.items[m.grid.itemFocused]
        if item = invalid then return true
        menu = mqCardMenu(item, false)
        if menu = invalid then return true
        m.menuItem = item
        m.menuActs = menu.acts
        openMenu("card", menu.title, menu.labels, -1)
        return true
    end if
    return false
end function
